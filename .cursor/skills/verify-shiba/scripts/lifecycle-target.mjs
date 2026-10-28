import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Both targets load the real dashboard; Electron additionally verifies its native boundary. */
export async function launchLifecycleTarget(base, chromium) {
  if (process.env.VERIFY_DESKTOP !== "1") {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.VERIFY_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.VERIFY_BROWSER_EXECUTABLE_PATH } : {}),
    });
    const context = await browser.newContext();
    return { context, page: await context.newPage(), close: () => browser.close(), target: "web" };
  }

  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { _electron } = desktopRequire("playwright-core");
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "shiba-desktop-lifecycle-"));
  let app;
  try {
    app = await _electron.launch({
      chromiumSandbox: true,
      cwd: root,
      args: [path.join(root, "apps/desktop/dist/main.js"), `--user-data-dir=${path.join(fixtureRoot, "profile")}`],
      env: {
        ...process.env,
        SHIBA_DESKTOP_URL: base.origin,
        SHIBA_DESKTOP_SETUP: "0",
        SHIBA_LOCAL_RUN_ROOT: path.join(fixtureRoot, "runs"),
      },
    });
    const page = await app.firstWindow();
    await page.waitForURL(`${base.origin}/app/**`);
    const bridge = await page.evaluate(() => ({ desktop: typeof window.shibaDesktop !== "undefined", require: typeof window.require }));
    assert.deepEqual(bridge, { desktop: true, require: "undefined" });
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: options.sandbox, contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert(!app.process().spawnargs.includes("--no-sandbox"), "Electron must retain its renderer sandbox");
    return {
      context: app.context(),
      page,
      target: "desktop",
      desktopEvidence: { platform: process.platform, bridge, preferences, electronVersion: await app.evaluate(() => process.versions.electron) },
      async close() {
        try { await app.close(); } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await app?.close().catch(() => {});
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}
