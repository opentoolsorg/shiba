/**
 * T65/T66 e2e smoke: launches the built app with playwright-core's electron
 * driver. Runs via pnpm --filter @shiba/desktop test:e2e — intentionally
 * NOT part of pnpm test (needs a built dist + a display).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";

let stub: Server;
let stubUrl = "";
const userDataDirs: string[] = [];

// Local stand-in for the deployment's /app/ (loopback http is allowed unpackaged).
beforeAll(async () => {
  stub = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>stub</title><body>stub app</body>");
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => stub.close(r));
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true });
});

// Fresh userData per launch so one test's saved URL/state can't leak into the next.
const launch = (env: Record<string, string>) => {
  const userData = mkdtempSync(path.join(tmpdir(), "shiba-e2e-"));
  userDataDirs.push(userData);
  return electron.launch({
    chromiumSandbox: true,
    args: ["dist/main.js", `--user-data-dir=${userData}`],
    env: { ...(process.env as Record<string, string>), ...env },
  });
};

test("setup page renders when no URL is configured", async () => {
  const app = await launch({ SHIBA_DESKTOP_URL: "" });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    expect(win.url()).toMatch(/setup\.html/);
    await expect(win.locator("input#url").isVisible()).resolves.toBe(true);

    // D4: setup.html gets only the setup bridge, never the app bridge.
    const bridges = await win.evaluate(() => {
      const w = window as unknown as { shibaSetup?: unknown; shibaDesktop?: unknown };
      return { hasSetup: w.shibaSetup !== undefined, hasDesktop: w.shibaDesktop !== undefined };
    });
    expect(bridges).toEqual({ hasSetup: true, hasDesktop: false });
  } finally {
    await app.close();
  }
});

test("interactive setup overrides the initial setup hint and opens the selected deployment", async () => {
  const app = await launch({ SHIBA_DESKTOP_SETUP: "1", SHIBA_DESKTOP_URL: "" });
  try {
    const setup = await app.firstWindow();
    await setup.waitForURL(/setup\.html/);
    await setup.locator("input#url").fill(stubUrl);
    const opened = app.waitForEvent("window");
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    const dashboard = await opened;
    await dashboard.waitForURL(`${stubUrl}/app/**`);
    expect(await dashboard.locator("body").textContent()).toContain("stub app");
    expect(await dashboard.evaluate(() => {
      const w = window as unknown as { shibaDesktop?: unknown; shibaSetup?: unknown };
      return { desktop: w.shibaDesktop !== undefined, setup: w.shibaSetup !== undefined };
    })).toEqual({ desktop: true, setup: false });
    const artifacts = path.resolve(import.meta.dirname, "../../../.verify/desktop-shell");
    mkdirSync(artifacts, { recursive: true });
    await dashboard.screenshot({ path: path.join(artifacts, "interactive-setup.png") });
  } finally {
    await app.close();
  }
});

test("app loads after URL, bridge exposed, no Node, foreign nav blocked", async () => {
  const app = await launch({ SHIBA_DESKTOP_URL: stubUrl });
  try {
    const win = await app.firstWindow();
    await win.waitForURL(`${stubUrl}/app/**`);

    const bridge = await win.evaluate(() => {
      const w = window as unknown as { shibaDesktop?: unknown };
      return {
        hasBridge: w.shibaDesktop !== undefined,
        hasRequire: typeof require !== "undefined",
      };
    });
    // D4/D5: bridge exists on the app origin; renderer has no Node.
    expect(bridge.hasBridge).toBe(true);
    expect(bridge.hasRequire).toBe(false);
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      // Electron 44 exposes this runtime diagnostic but omits it from its generated types.
      // Renderer bridge/Node behavior is asserted independently above.
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean };
      };
      const options = contents.getLastWebPreferences();
      return { sandbox: options.sandbox, contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration };
    });
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(app.process().spawnargs).not.toContain("--no-sandbox");

    // Stub openExternal: records the hand-off (our wait condition) and keeps a real browser closed.
    await app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => {
        g.__opened!.push(url);
      };
    });

    // Foreign navigation must not stay in-app (D6 allowlist): it is handed to the OS browser.
    await win.evaluate(() => {
      window.location.href = "https://example.com";
    });
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []))
      .toContain("https://example.com/");
    expect(win.url().startsWith(stubUrl)).toBe(true);
  } finally {
    await app.close();
  }
});
