#!/usr/bin/env node
/**
 * Screenshot harness for the Work + Agents dashboard against a real deployment.
 *
 *   SHIBA_URL=https://… SHIBA_EMAIL=… SHIBA_PASSWORD=… node scripts/ui-shots.mjs [outDir] [--only a,b] [--dry-run]
 *
 * Signs in through the real login form, captures each scene in dark + light at
 * 1440px and 390px, prints a JSON manifest, and archives the one task it creates.
 * Optional env: SHIBA_HEADLESS=0, SHIBA_BROWSER_PATH, SHIBA_BROWSER_CHANNEL (e.g. chrome),
 * SHIBA_SHOT_TIMEOUT_MS. Credentials are never printed or written to disk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? "").split(",").filter(Boolean)) : null;
const positional = args.filter((a, i) => !a.startsWith("--") && (onlyIdx < 0 || i !== onlyIdx + 1));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(positional[0] ?? join(root, ".verify", "ui-shots", stamp));
const timeout = Number(process.env.SHIBA_SHOT_TIMEOUT_MS || 20_000);

const THEMES = ["dark", "light"];
const VIEWPORTS = [
  { id: "1440", width: 1440, height: 900 },
  { id: "390", width: 390, height: 844 },
];
const TASK_TITLE = `ui-shots ${stamp}`;
const WORK_LIST_RE = /\/api\/workspaces\/([^/]+)\/work(?:\?|$)/;
const AGENT_LIST = (page) => page.getByRole("list", { name: "Custom agents" });

// "baseline" runs before the harness creates its task, so the list can show a real empty state.
const SCENES = [
  { id: "work-list-empty", phase: "baseline", path: "/", run: (p) => showWorkView(p, "List") },
  { id: "agents-list-expanded", phase: "baseline", path: "/custom-agents/", run: expandFirstAgent },
  { id: "agent-chat-empty", phase: "baseline", path: "/custom-agents/", run: openFirstAgentChat },
  { id: "template-catalog", phase: "baseline", path: "/custom-agents/", run: showTemplateCatalog },
  { id: "work-list-task", phase: "with-task", path: "/", run: showTaskInList },
  { id: "work-board", phase: "with-task", path: "/", run: (p) => showWorkView(p, "Board") },
  { id: "work-timeline", phase: "with-task", path: "/", run: (p) => showWorkView(p, "Timeline") },
  {
    id: "work-organization",
    phase: "with-task",
    path: "/",
    run: (p) => showWorkView(p, "Organization"),
  },
  { id: "task-detail", phase: "with-task", path: "/", run: openTaskDetail },
].filter((s) => !only || only.has(s.id));

const fileFor = (scene, theme, vp) => `${scene.id}--${theme}--${vp.id}.png`;

if (dryRun) {
  const plan = SCENES.flatMap((scene) =>
    THEMES.flatMap((theme) =>
      VIEWPORTS.map((vp) => ({
        scene: scene.id,
        phase: scene.phase,
        theme,
        viewport: vp.width,
        path: scene.path,
        file: join(outDir, fileFor(scene, theme, vp)),
      })),
    ),
  );
  const env = Object.fromEntries(
    ["SHIBA_URL", "SHIBA_EMAIL", "SHIBA_PASSWORD"].map((k) => [k, Boolean(process.env[k])]),
  );
  console.log(
    JSON.stringify({ dryRun: true, outDir, envSet: env, shots: plan.length, plan }, null, 2),
  );
  process.exit(0);
}

const missing = ["SHIBA_URL", "SHIBA_EMAIL", "SHIBA_PASSWORD"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`ui-shots: missing env ${missing.join(", ")} (see --dry-run)`);
  process.exit(2);
}
const base = new URL(process.env.SHIBA_URL).origin;

async function loadChromium() {
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return (await import(spec)).chromium;
    } catch {
      /* try next */
    }
  }
  // apps/desktop pins playwright-core; resolve it from there when the root has none.
  try {
    const req = createRequire(join(root, "apps/desktop/package.json"));
    return (await import(req.resolve("playwright-core"))).chromium;
  } catch {
    throw new Error(
      "ui-shots: install playwright (npx playwright install chromium) or set NODE_PATH to one",
    );
  }
}

async function firstVisible(candidates, ms = timeout) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      const el = loc.first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no visible match");
}

async function dismissOnboarding(page) {
  const skip = page.getByRole("button", { name: "Skip setup" });
  if (
    await skip
      .first()
      .isVisible()
      .catch(() => false)
  )
    await skip.first().click();
}

async function showWorkView(page, name) {
  const views = page.getByRole("group", { name: "Work views" });
  const btn = await firstVisible([
    views.getByRole("button", { name, exact: true }),
    page.getByRole("tab", { name, exact: true }),
    page.getByRole("link", { name, exact: true }),
    page.getByRole("button", { name, exact: true }),
  ]);
  await btn.click();
}

async function showTaskInList(page) {
  await showWorkView(page, "List");
  await page.getByText(TASK_TITLE).first().waitFor({ timeout });
}

async function openTaskDetail(page) {
  await showTaskInList(page);
  await page.getByText(TASK_TITLE).first().click();
  await firstVisible([
    page.getByRole("dialog"),
    page.getByRole("complementary", { name: /task/i }),
    page.getByRole("region", { name: /task/i }),
  ]);
}

async function expandFirstAgent(page) {
  const expand = await firstVisible([
    AGENT_LIST(page).getByRole("button", { name: /^Expand / }),
    page.getByRole("button", { name: /^Expand / }),
  ]);
  await expand.click();
}

async function openFirstAgentChat(page) {
  await AGENT_LIST(page).locator("button").first().click({ timeout });
  await page
    .getByText(/beginning of your conversation/i)
    .first()
    .waitFor({ timeout });
}

async function showTemplateCatalog(page) {
  const catalog = page.locator("#agent-catalog");
  if (!(await catalog.count())) {
    // Catalog sits behind the empty-state CTA or a new-agent button when agents already exist.
    const cta = await firstVisible([
      page.getByRole("button", { name: /hire your first teammate/i }),
      page.getByRole("button", { name: /new agent|browse templates/i }),
    ]);
    await cta.click();
  }
  await catalog.first().scrollIntoViewIfNeeded({ timeout });
}

async function signIn(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  const email = page.locator('input[type="email"]');
  await email.first().waitFor({ timeout: timeout * 2 });
  await email.first().fill(process.env.SHIBA_EMAIL);
  await page
    .locator('input[type="password"][autocomplete="current-password"]')
    .first()
    .fill(process.env.SHIBA_PASSWORD);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await email
    .first()
    .waitFor({ state: "detached", timeout: timeout * 2 })
    .catch(async () => {
      const alert = await page
        .getByRole("alert")
        .first()
        .textContent()
        .catch(() => null);
      throw new Error(`ui-shots: sign-in failed${alert ? `: ${alert.trim()}` : ""}`);
    });
  await page.close();
  return context;
}

async function capturePhase(browser, storageState, phase, manifest, state) {
  const scenes = SCENES.filter((s) => s.phase === phase);
  if (!scenes.length) return;
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        storageState,
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem("shiba-theme", t);
        } catch {
          /* storage blocked */
        }
      }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      for (const scene of scenes) {
        const file = join(outDir, fileFor(scene, theme, vp));
        const entry = { scene: scene.id, theme, viewport: vp.width, file, ok: false };
        try {
          const listed = page
            .waitForResponse((r) => r.request().method() === "GET" && WORK_LIST_RE.test(r.url()), {
              timeout,
            })
            .catch(() => null);
          await page.goto(`${base}${scene.path}`, { waitUntil: "domcontentloaded" });
          await dismissOnboarding(page);
          if (scene.path === "/") {
            const res = await listed;
            const body = res?.ok() ? await res.json().catch(() => null) : null;
            if (body) {
              state.workspaceId ??= body.workspaceId;
              entry.taskCount = Array.isArray(body.tasks) ? body.tasks.length : null;
            }
          }
          await scene.run(page);
          entry.ok = true;
        } catch (error) {
          entry.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
        }
        // Capture even on failure so a broken scene is visible in review.
        await page.screenshot({ path: file, animations: "disabled" }).catch((e) => {
          entry.error ??= `screenshot: ${e.message}`;
        });
        if (scene.id === "work-list-empty" && entry.taskCount > 0)
          entry.note = "workspace already has tasks; empty state not shown";
        manifest.push(entry);
        console.error(
          `${entry.ok ? "ok  " : "FAIL"} ${scene.id} ${theme} ${vp.width}${entry.error ? ` (${entry.error})` : ""}`,
        );
      }
      await context.close();
    }
  }
}

async function createTask(browser, storageState, state) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  try {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
    await showWorkView(page, "List");
    let input = await firstVisible(
      [page.getByPlaceholder(/add a task/i), page.getByRole("textbox", { name: /add a task/i })],
      timeout / 2,
    ).catch(() => null);
    if (!input) {
      await page.getByRole("button", { name: "New task" }).first().click();
      input = await firstVisible([
        page.getByPlaceholder(/add a task|task title/i),
        page.getByRole("textbox", { name: /add a task|title/i }),
      ]);
    }
    const created = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/workspaces\/[^/]+\/work$/.test(r.url()),
      { timeout },
    );
    await input.fill(TASK_TITLE);
    await input.press("Enter");
    const res = await created;
    const { task } = await res.json();
    state.task = { id: task.id, workspaceId: task.workspaceId };
  } finally {
    await context.close();
  }
}

async function archiveTask(context, state) {
  if (!state.task) return null;
  const { id, workspaceId } = state.task;
  const res = await context.request.post(
    `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/work/${encodeURIComponent(id)}/archive`,
    {
      headers: { "X-Shiba-Workspace": workspaceId, "content-type": "application/json" },
      data: {},
    },
  );
  return res.ok() ? "archived" : `archive failed: HTTP ${res.status()}`;
}

mkdirSync(outDir, { recursive: true });
const chromium = await loadChromium();
const browser = await chromium.launch({
  headless: process.env.SHIBA_HEADLESS !== "0",
  ...(process.env.SHIBA_BROWSER_PATH ? { executablePath: process.env.SHIBA_BROWSER_PATH } : {}),
  ...(process.env.SHIBA_BROWSER_CHANNEL ? { channel: process.env.SHIBA_BROWSER_CHANNEL } : {}),
});
const manifest = [];
const state = { workspaceId: null, task: null };
const summary = { base, outDir, taskTitle: TASK_TITLE, cleanup: null };
let auth;
try {
  auth = await signIn(browser);
  // Session cookies stay in memory only; never persisted beside the PNGs.
  const storageState = await auth.storageState();
  await capturePhase(browser, storageState, "baseline", manifest, state);
  if (SCENES.some((s) => s.phase === "with-task")) {
    try {
      await createTask(browser, storageState, state);
    } catch (error) {
      summary.createError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    await capturePhase(browser, storageState, "with-task", manifest, state);
  }
} finally {
  if (auth)
    summary.cleanup = await archiveTask(auth, state).catch((e) => `archive failed: ${e.message}`);
  await browser.close();
  const result = { ...summary, shots: manifest };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
process.exit(manifest.every((e) => e.ok) && !summary.createError ? 0 : 1);
