import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runManagedContextProof, verifyManagedContextApproval, verifyManagedContextDraft } from "./managed-context.mjs";
import { createReasonNetworkCompanion } from "../../../../scripts/reason-network-companion.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const backendDir = path.join(root, "apps/backend");
const frontendDir = path.join(root, "apps/frontend");
const workerPort = process.env.SHIBA_ACCEPTANCE_PORT ?? "8788";
const workerOrigin = `http://localhost:${workerPort}`;
const workerLoopbackOrigin = `http://127.0.0.1:${workerPort}`;
const tempRoot = await mkdtemp(path.join(tmpdir(), "shiba-browser-acceptance-"));
const stateDir = path.join(tempRoot, "wrangler-state");
const outputDir = process.env.SHIBA_ACCEPTANCE_OUTPUT_DIR ?? path.join(tmpdir(), "shiba-e2e-acceptance");
const screenshotDir = path.join(outputDir, "screenshots");
const screenshotPath = path.join(screenshotDir, `${path.basename(tempRoot)}-journey.png`);
await mkdir(screenshotDir, { recursive: true });
const evidencePath = path.join(outputDir, "browser.latest.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

const varsPath = path.join(backendDir, ".dev.vars");
let varsOwned = false;
const children = [];
const logs = [];
const checkpoints = [];
const adapterEvents = [];
const browserEvents = [];
const externalFontRequests = [];
let adapterTimer;
let heartbeatTimer;
let managedContext = null;
let browser;

function logChild(child, name) {
  const collect = (stream, level) =>
    stream.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) logs.push(`${name} ${level}: ${line}`);
      if (logs.length > 250) logs.splice(0, logs.length - 250);
    });
  collect(child.stdout, "out");
  collect(child.stderr, "err");
  child.on("exit", (code, signal) => logs.push(`${name} exit: ${code ?? signal}`));
  children.push({ child, name });
  return child;
}

function start(name, command, args, cwd, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return logChild(child, name);
}

async function waitFor(description, operation, { timeoutMs = 75_000, intervalMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    const exited = children.find(({ child }) => child.exitCode !== null);
    if (exited) {
      throw new Error(
        `${description}: ${exited.name} exited with ${exited.child.exitCode}; ${logs.slice(-20).join("\n")}`,
      );
    }
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function jsonPost(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {}
  if (!response.ok)
    throw new Error(
      `Local fixture adapter POST ${new URL(url).pathname} returned ${response.status}: ${text}`,
    );
  return body;
}

async function stopAll() {
  if (adapterTimer) clearInterval(adapterTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await browser?.close().catch(() => {});
  for (const { child } of children.reverse()) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await delay(500);
  for (const { child } of children) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  if (varsOwned) await rm(varsPath, { force: true });
}

async function nav(page, view) {
  await page.goto(`${workerOrigin}/${view === "tasks" ? "" : `${view}/`}`, {
    waitUntil: "domcontentloaded",
  });
}

async function apiJson(page, url, init) {
  return page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(body)}`);
      return body;
    },
    { url, init },
  );
}

const evidence = {
  schemaVersion: 1,
  runId: path.basename(tempRoot),
  mode: "real-local-worker-do-d1-browser-with-deterministic-local-adapter",
  providers: {
    model: "not called",
    sandbox: "not called",
    github: "not called",
    externalWrites: false,
  },
  status: "failed",
  checkpoints,
  screenshots: [],
  adapterEvents,
  browserEvents,
  externalFontRequests,
  error: null,
  workerLogs: [],
};

try {
  const existingVars = await readFile(varsPath, "utf8").catch(() => null);
  if (existingVars !== null)
    throw new Error(
      "Refusing to overwrite apps/backend/.dev.vars; remove or move it, then rerun the local acceptance suite.",
    );
  const authSecret = `acceptance-local-secret-${"a".repeat(32)}`;
  const adapterToken = `acceptance-adapter-token-${"b".repeat(32)}`;
  await writeFile(
    varsPath,
    [
      `BETTER_AUTH_SECRET=${authSecret}`,
      `BETTER_AUTH_URL=${workerOrigin}`,
      "SHIBA_LOCAL_RUNTIME=1",
      "REASON_NETWORK_ENABLED=1",
      `PAIRING_SECRET=acceptance-pairing-secret-${"c".repeat(32)}`,
      `LOCAL_ADAPTER_TOKEN=${adapterToken}`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  varsOwned = true;

  const packageManager = "corepack";
  const packageManagerPrefix = ["pnpm@10.34.4"];
  const ciEnv = {
    ...process.env,
    CI: "true",
    ASTRO_TELEMETRY_DISABLED: "1",
    XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
    XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
    XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
    WRANGLER_LOG_PATH: path.join(tempRoot, "wrangler-logs"),
  };
  const build = spawnSync(packageManager, [...packageManagerPrefix, "build:dashboard"], {
    cwd: root,
    env: ciEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (build.status !== 0)
    throw new Error(`Dashboard build failed before browser run.\n${build.stdout}\n${build.stderr}`);
  const workerAssets = path.join(root, "app-public");
  await rm(workerAssets, { recursive: true, force: true });
  await cp(path.join(frontendDir, "dist/client"), workerAssets, {
    recursive: true,
    filter: (source) => path.basename(source) !== "_redirects",
  });

  start(
    "worker",
    packageManager,
    [
      ...packageManagerPrefix,
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      workerPort,
      "--config",
      "apps/backend/wrangler.jsonc",
      "--enable-containers=false",
      "--local-upstream",
      "localhost",
      "--persist-to",
      stateDir,
    ],
    root,
    ciEnv,
  );
  await waitFor(`local Worker on port ${workerPort}`, async () => {
    const response = await fetch(`${workerLoopbackOrigin}/api/auth/bootstrap`).catch(() => null);
    return response?.ok;
  });

  await waitFor("dashboard shell served by the local Worker", async () => {
    const response = await fetch(`${workerOrigin}/app/`, { redirect: "manual" }).catch(() => null);
    return response?.status === 200 && new URL(response.url).origin === workerOrigin;
  });

  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { chromium } = desktopRequire("playwright-core");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SHIBA_BROWSER_EXECUTABLE ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/chromium"),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // Prove app startup does not require external font hosts. The application
  // should not request them; if a future change adds a request, block it and
  // fail the acceptance assertion below rather than supplying replacement CSS.
  await context.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, async (route) => {
    externalFontRequests.push(route.request().url());
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const recordBrowserEvent = (event) => {
    browserEvents.push({ at: new Date().toISOString(), ...event });
    if (browserEvents.length > 300) browserEvents.splice(0, browserEvents.length - 300);
  };
  page.on("request", (request) => recordBrowserEvent({ kind: "request", url: request.url(), resourceType: request.resourceType() }));
  page.on("response", (response) => recordBrowserEvent({ kind: "response", url: response.url(), status: response.status() }));
  page.on("requestfailed", (request) => recordBrowserEvent({ kind: "requestfailed", url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
  page.on("domcontentloaded", () => recordBrowserEvent({ kind: "domcontentloaded", url: page.url() }));
  page.on("load", () => recordBrowserEvent({ kind: "load", url: page.url() }));
  page.on("console", (message) => recordBrowserEvent({ kind: "console", level: message.type(), text: message.text().slice(0, 500) }));
  page.on("pageerror", (error) => logs.push(`browser pageerror: ${error.message}`));
  await page.goto(`${workerOrigin}/app/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "First sign-in? Create the account" }).click();
  assert.deepEqual(externalFontRequests, [], "App bootstrap must not request external fonts.");
  await page.getByLabel("Name").fill("Shiba Acceptance Owner");
  await page.getByLabel("Email").fill("acceptance-owner@example.test");
  await page.getByLabel("Password").fill("e2e-password-2026!");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("region", { name: "First task setup" }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const goalText = "A reply draft grounded in a selected email";
  let failedSetupSave = false;
  await page.route("**/api/onboarding/progress", async (route) => {
    const request = route.request();
    if (!failedSetupSave && request.method() === "POST" && request.postDataJSON()?.action === "save-draft") {
      failedSetupSave = true;
      await route.abort("failed");
    } else await route.continue();
  });
  const goalChip = page.getByRole("button", { name: goalText, exact: true });
  await goalChip.focus();
  await goalChip.press("Enter");
  await page.getByRole("region", { name: "Setup recovery" }).waitFor();
  await page.unroute("**/api/onboarding/progress");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Your answer: Goal" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Your answer: Goal" }).inputValue(), goalText);
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Audience" }).waitFor();
  await page.getByRole("button", { name: "A customer", exact: true }).press("Enter");
  const acceptanceText = "Use only supported facts, cite the selected source, and never send.";
  await page.getByRole("textbox", { name: "Your answer: Acceptance" }).fill(acceptanceText);
  await page.getByRole("textbox", { name: "Your answer: Acceptance" }).press("Control+Enter");
  await page.getByRole("textbox", { name: "Your answer: Your role" }).waitFor();
  await page.getByRole("button", { name: "Skip question", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Help" }).waitFor();
  await page.getByRole("button", { name: "Writing and editing", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Employee" }).waitFor();
  await page.getByRole("button", { name: /Research Produce a sourced report/ }).click();
  const suppliedContext = "Use only supplied fixture facts. Connection and resource grants remain separate.";
  await page.getByRole("textbox", { name: "Your answer: Context" }).fill(suppliedContext);
  await page.getByRole("textbox", { name: "Your answer: Context" }).press("Control+Enter");
  await page.getByRole("textbox", { name: "Your answer: Connections" }).waitFor();
  await page.getByRole("button", { name: "Review connections, then return", exact: true }).click();
  await waitFor("connection navigation", () => page.url().includes("/integrations"));
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "Saved first task draft" }).waitFor();
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Connections" }).waitFor();
  assert.ok(await page.getByRole("log", { name: "Setup conversation" }).getByText(acceptanceText, { exact: true }).isVisible());
  await page.getByRole("button", { name: "I will use supplied context first", exact: true }).click();
  await page.getByRole("region", { name: "First task draft review" }).waitFor();
  let prepareRequests = 0;
  const countPrepare = (request) => {
    if (request.url().endsWith("/api/onboarding/progress") && request.method() === "POST" && request.postDataJSON()?.action === "prepare-task") prepareRequests += 1;
  };
  page.on("request", countPrepare);
  await page.getByRole("button", { name: "Create first task draft", exact: true }).evaluate((button) => { button.click(); button.click(); });
  await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
  page.off("request", countPrepare);
  const preparedSetup = await apiJson(page, "/api/onboarding/progress");
  assert.equal(prepareRequests, 1);
  assert.equal(preparedSetup.draftTask.goal, goalText);
  assert.equal(preparedSetup.draftTask.audience, "A customer");
  assert.equal(preparedSetup.draftTask.acceptance, acceptanceText);
  assert.equal(preparedSetup.draftTask.employeeId, null);
  assert.equal(preparedSetup.draftTask.employeeTemplateId, "research");
  assert.ok(preparedSetup.draftTask.preparedAt);
  assert.equal(preparedSetup.activatedAt, null);
  assert.deepEqual(preparedSetup.draftTask.sourceRefs, []);
  assert.equal((await apiJson(page, "/api/runs")).runs.length, 0);
  assert.equal((await apiJson(page, "/api/custom-agents")).agents.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const onboardingScreenshot = path.join(screenshotDir, `${path.basename(tempRoot)}-onboarding-narrow.png`);
  await page.screenshot({ path: onboardingScreenshot, fullPage: true });
  evidence.screenshots.push(onboardingScreenshot);
  checkpoints.push({ id: "conversational-onboarding-answers-recovery-review", status: "passed", draftTaskId: preparedSetup.draftTaskId, version: preparedSetup.draftTask.version, prepareRequests, viewport: "375x812", reducedMotion: true, runsCreated: 0, employeesCreated: 0 });
  await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
  await page.getByRole("group", { name: "Selected first-task goal" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("group", { name: "Selected first-task goal" }).waitFor();
  const taskInput = page.getByRole("textbox", { name: "Task description" });
  const canonicalTask = await taskInput.inputValue();
  assert.ok(canonicalTask.startsWith(goalText));
  // A second local fixture identity exercises the same-browser cache boundary.
  // Copy only the fixture password hash inside isolated SQLite; no token is read or granted.
  const secondOwnerSql = `
    INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt)
      SELECT 'acceptance-owner-b','Acceptance Other Owner','acceptance-other@example.test',emailVerified,createdAt,updatedAt
      FROM "user" WHERE email='acceptance-owner@example.test';
    INSERT INTO "account" (id,accountId,providerId,userId,password,createdAt,updatedAt)
      SELECT 'acceptance-account-b','acceptance-owner-b',providerId,'acceptance-owner-b',password,createdAt,updatedAt
      FROM "account" WHERE userId=(SELECT id FROM "user" WHERE email='acceptance-owner@example.test') AND providerId='credential';
  `;
  const secondOwnerSeed = spawnSync(packageManager, [...packageManagerPrefix, "exec", "wrangler", "d1", "execute", "shiba-audit", "--local", "--persist-to", stateDir, "--config", "apps/backend/wrangler.jsonc", "--command", secondOwnerSql, "--json"], { cwd: root, env: ciEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(secondOwnerSeed.status, 0, `Second local owner fixture failed: ${secondOwnerSeed.stderr}`);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: /workspace/ }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to continue", exact: true }).waitFor();
  assert.equal(await page.getByRole("group", { name: "Selected first-task goal" }).count(), 0);
  await page.getByLabel("Email").fill("acceptance-other@example.test");
  await page.getByLabel("Password").fill("e2e-password-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Goal" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Your answer: Goal" }).inputValue(), "");
  assert.equal(await page.getByRole("log", { name: "Setup conversation" }).getByText(goalText, { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Skip setup", exact: true }).click();
  await taskInput.waitFor();
  assert.equal(await taskInput.inputValue(), "");
  assert.equal(await page.getByRole("group", { name: "Selected first-task goal" }).count(), 0);
  assert.equal(await page.getByText(goalText, { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Send task", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: /workspace/ }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in to continue", exact: true }).waitFor();
  await page.getByLabel("Email").fill("acceptance-owner@example.test");
  await page.getByLabel("Password").fill("e2e-password-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("group", { name: "Selected first-task goal" }).waitFor();
  assert.equal(await taskInput.inputValue(), canonicalTask);
  checkpoints.push({ id: "onboarding-owner-scoped-composer", status: "passed", sameBrowser: true, otherOwnerTextVisible: false, otherOwnerSendDisabled: true, originalOwnerRestored: true });
  // A same-owner refresh must not silently turn a linked goal into ordinary work.
  const beforeChangedSetup = await apiJson(page, "/api/onboarding/progress");
  const changedSetup = await apiJson(page, "/api/onboarding/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-draft", expectedRevision: beforeChangedSetup.revision, draftTask: { audience: "A changed audience" } }) });
  await apiJson(page, "/api/onboarding/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare-task", expectedRevision: changedSetup.revision }) });
  let staleRunRequests = 0;
  let staleAppMessages = 0;
  const countStaleRun = (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/runs") staleRunRequests += 1; };
  const countStaleSocket = (socket) => socket.on("framesent", ({ payload }) => { if (String(payload).includes("cf_agent_use_chat_request")) staleAppMessages += 1; });
  page.on("request", countStaleRun);
  page.on("websocket", countStaleSocket);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("group", { name: "Selected first-task goal" }).getByText(/saved version needs review/).waitFor();
  assert.equal(await taskInput.inputValue(), canonicalTask);
  await page.getByRole("combobox", { name: "Work target", exact: true }).selectOption("artifact-workspace");
  await page.getByRole("textbox", { name: "Artifact deliverables", exact: true }).fill("deliverables/stale-goal.md");
  const staleSend = page.getByRole("button", { name: "Send task", exact: true });
  assert.equal(await staleSend.isDisabled(), true);
  await taskInput.press("Control+Enter");
  await taskInput.press("Meta+Enter");
  // Let App effects, keyboard handlers, and the debounced composer cache settle.
  await page.waitForTimeout(500);
  assert.equal(staleRunRequests, 0);
  assert.equal(staleAppMessages, 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("group", { name: "Selected first-task goal" }).getByText(/saved version needs review/).waitFor();
  assert.equal(await taskInput.inputValue(), canonicalTask);
  await page.getByRole("combobox", { name: "Work target", exact: true }).selectOption("artifact-workspace");
  await page.getByRole("textbox", { name: "Artifact deliverables", exact: true }).fill("deliverables/stale-goal.md");
  assert.equal(await staleSend.isDisabled(), true);
  await page.getByRole("button", { name: "Remove first-task goal link", exact: true }).click();
  await page.getByRole("group", { name: "Selected first-task goal" }).waitFor({ state: "detached" });
  assert.equal(await staleSend.isDisabled(), false);
  page.off("request", countStaleRun);
  page.off("websocket", countStaleSocket);
  checkpoints.push({ id: "onboarding-stale-goal-stays-bound", status: "passed", staleRunRequests, staleAppMessages, explicitRemovalRequired: true, reloadPreserved: true });
  await taskInput.fill(`${canonicalTask}\nAn edited ordinary task.`);
  await page.getByRole("group", { name: "Selected first-task goal" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Use first task draft", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Replace unsent task" }).waitFor();
  await page.getByRole("button", { name: "Keep current task", exact: true }).click();
  assert.ok((await taskInput.inputValue()).endsWith("An edited ordinary task."));
  assert.equal((await apiJson(page, "/api/runs")).runs.length, 0);
  checkpoints.push({ id: "onboarding-goal-composer-reload-edit", status: "passed", linkedDraftRestored: true, editingClearsLink: true, replacementConfirmed: true, runsCreated: 0 });
  await taskInput.fill("");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await page.getByRole("button", { name: "Advanced setup guide", exact: true }).click();
  await page.getByRole("dialog", { name: "Welcome setup" }).waitFor();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("heading", { name: "Your agent" }).waitFor();
  await page.getByRole("button", { name: "Close setup" }).click();
  await page.getByRole("dialog", { name: "Welcome setup" }).waitFor({ state: "detached" });
  const afterDismiss = await apiJson(page, "/api/onboarding/progress");
  assert.equal(afterDismiss.currentStep, "agent");
  assert.ok(afterDismiss.dismissedAt);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("dialog", { name: "Welcome setup" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: /workspace/ }).click();
  await page.getByRole("menuitem", { name: "Finish setting up" }).click();
  await page.getByRole("button", { name: "Advanced setup guide", exact: true }).click();
  await page.getByRole("heading", { name: "Your agent" }).waitFor();
  checkpoints.push({
    id: "onboarding-close-reload-resume",
    status: "passed",
    currentStep: afterDismiss.currentStep,
    revision: afterDismiss.revision,
  });
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("heading", { name: "Model routing" }).waitFor();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("heading", { name: "Your first employee" }).waitFor();
  await page.getByRole("button", { name: "Set up research →" }).evaluate((button) => { button.click(); button.click(); });
  await page.getByRole("heading", { name: "Bots", exact: true }).waitFor();
  const interruptedName = "Interrupted onboarding research draft";
  await page.getByLabel("Name", { exact: true }).fill(interruptedName);
  const advancedSettings = page.getByText("Advanced settings", { exact: true });
  assert.equal(await advancedSettings.evaluate((summary) => summary.closest("details").open), false);
  await advancedSettings.focus();
  await advancedSettings.press("Enter");
  assert.equal(await advancedSettings.evaluate((summary) => summary.closest("details").open), true);
  assert.equal(await advancedSettings.evaluate((summary) => document.activeElement === summary), true);
  await page.getByLabel("Default repository").fill("https://github.com/example/onboarding-draft");
  await nav(page, "providers");
  await page.getByRole("heading", { name: /Providers/ }).first().waitFor();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Bots", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), interruptedName);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Providers/ }).first().waitFor();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Bots", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), interruptedName);
  assert.equal(await page.getByLabel("Default repository").inputValue(), "https://github.com/example/onboarding-draft");
  const beforeCreate = await apiJson(page, "/api/custom-agents");
  assert.equal(beforeCreate.agents.length, 0, "Onboarding and draft recovery must not create a bot.");
  const roleProgress = await apiJson(page, "/api/onboarding/progress");
  assert.equal(roleProgress.currentStep, "employee");
  assert.equal(roleProgress.activatedAt, null);
  checkpoints.push({ id: "onboarding-role-draft-back-forward-reload", status: "passed", draftRestored: true, botsCreated: 0, activated: false });
  await page.getByRole("button", { name: "Discard draft" }).click();

  await nav(page, "skills");
  await page.getByRole("heading", { name: "Skills" }).waitFor();
  await page.getByLabel("Skill name").fill("Acceptance research rules");
  await page
    .getByLabel("Skill instructions")
    .fill("Use only fixture facts and return a concise report.");
  await page.getByRole("button", { name: "Save draft" }).click();
  const skillRow = page
    .getByText("Acceptance research rules", { exact: true })
    .locator("xpath=ancestor::li");
  await skillRow.waitFor();
  await skillRow.getByRole("button", { name: "Mark reviewed" }).click();
  await skillRow.getByRole("button", { name: "Activate reviewed version" }).click();
  await skillRow.getByText("active · v1", { exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Acceptance research rules", { exact: true }).waitFor();
  const skillsApi = await apiJson(page, "/api/skills");
  const activeSkill = skillsApi.skills.find((skill) => skill.name === "Acceptance research rules");
  assert.equal(activeSkill?.status, "active");
  checkpoints.push({
    id: "skill-review-activate-reload",
    status: "passed",
    skillId: activeSkill.id,
    version: activeSkill.version,
  });

  // Pair a deterministic test adapter over the same supported /api/local protocol.
  const pairing = await apiJson(page, "/api/computers/pairing-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const paired = await fetch(`${workerOrigin}/api/local/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingToken: pairing.token,
      hostname: "acceptance-local-adapter",
      platform: "linux-x64",
      daemonVersion: "0.1.0",
      harnesses: ["opencode"],
    }),
  });
  const pairedBody = await paired.json();
  assert.equal(
    paired.status,
    200,
    `Deterministic adapter pairing failed: ${JSON.stringify(pairedBody)}`,
  );
  const daemonToken = pairedBody.adapterToken;
  const machineId = pairedBody.machineId;
  const heartbeat = () =>
    jsonPost(`${workerOrigin}/api/local/heartbeat`, daemonToken, {
      machineId,
      hostname: "acceptance-local-adapter",
      platform: "linux-x64",
      daemonVersion: "0.1.0",
      harnesses: ["opencode"],
      // This isolated fixture implements the daemon heartbeat contract; it
      // never starts the native upstream executable or contacts a peer.
      reasonNetworkCompanion: true,
    });
  await heartbeat();

  await nav(page, "integrations");
  await page.getByRole("heading", { name: "Integrations" }).waitFor();
  await page.getByRole("heading", { name: "Reason Network (OSS)" }).waitFor();
  await page.getByLabel("Reason conversation ID").fill("acceptance-reason-conversation");
  await page.getByLabel("Reason session ID").fill("acceptance-reason-session");
  await page.getByLabel("Paired companion machine ID").fill(machineId);
  await page.getByRole("button", { name: "Create local grant" }).click();
  await page
    .getByText(new RegExp(`acceptance-reason-conversation · acceptance-reason-session · machine ${machineId} · active`))
    .waitFor();
  await page.getByLabel("Exact peer destination").fill("peer:acceptance");
  await page.getByLabel("Exact message for approval").fill("Deterministic companion acceptance payload.");
  await page.getByRole("button", { name: "Request approval record" }).click();
  await page.getByText("Deterministic companion acceptance payload.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve record" }).click();
  await page.getByRole("button", { name: "Queue exact approved send" }).click();
  const reasonOperation = await waitFor("approved Reason operation queued", async () => {
    const operations = await apiJson(page, "/api/reason-network/v1/operations");
    return operations.operations?.find((item) => item.state === "queued");
  });
  const wrongPairing = await apiJson(page, "/api/computers/pairing-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const wrongPaired = await fetch(`${workerOrigin}/api/local/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingToken: wrongPairing.token,
      hostname: "acceptance-wrong-machine",
      platform: "linux-x64",
      daemonVersion: "0.1.0",
      harnesses: ["opencode"],
    }),
  });
  assert.equal(wrongPaired.status, 200);
  const wrongPairedBody = await wrongPaired.json();
  const wrongClaim = await jsonPost(
    `${workerOrigin}/api/local/reason-network/v1/claim`,
    wrongPairedBody.adapterToken,
    {},
  );
  assert.equal(wrongClaim.operation, null, "a different paired machine cannot claim this send");
  const claim = await jsonPost(`${workerOrigin}/api/local/reason-network/v1/claim`, daemonToken, {});
  assert.equal(claim.operation.operationId, reasonOperation.operationId);
  const fakeCalls = [];
  const fakeCompanion = createReasonNetworkCompanion({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: "send_message" }] }),
      callTool: async (input) => {
        fakeCalls.push(input);
        return { isError: false, content: [{ type: "text", text: "sent message id acceptance-message-1" }] };
      },
      close: async () => {},
    }),
    beforeSend: async (operation) => {
      const response = await fetch(
        `${workerOrigin}/api/local/reason-network/v1/operations/${encodeURIComponent(operation.operationId)}`,
        { headers: { authorization: `Bearer ${daemonToken}` } },
      );
      assert.equal(response.status, 200);
      const current = await response.json();
      return current.state === "claimed" && current.cancelRequested === false && current.sendAllowed === true;
    },
  });
  const sent = await fakeCompanion(claim.operation);
  assert.deepEqual(sent, { state: "accepted", messageId: "acceptance-message-1" });
  assert.equal(fakeCalls[0]._meta.sessionId, "acceptance-reason-session");
  const settled = await jsonPost(`${workerOrigin}/api/local/reason-network/v1/result`, daemonToken, {
    operationId: claim.operation.operationId,
    claimToken: claim.operation.claimToken,
    state: sent.state,
    messageId: sent.messageId,
  });
  assert.equal(settled.state, "accepted");
  const reasonStatus = await apiJson(page, "/api/reason-network/status");
  const finalOperation = await apiJson(page, `/api/reason-network/v1/operations/${encodeURIComponent(reasonOperation.operationId)}`);
  assert.equal(reasonStatus.dispatchConfigured, true);
  assert.equal(finalOperation.operationId, reasonOperation.operationId);
  assert.equal(finalOperation.state, "accepted");
  assert.equal(finalOperation.remoteMessageId, "acceptance-message-1");
  checkpoints.push({
    id: "reason-worker-queue-fake-companion-result",
    status: "passed",
    machineId,
    wrongMachineDenied: true,
    fakeMcpCalls: fakeCalls.length,
    operationId: reasonOperation.operationId,
    remoteMessageId: settled.messageId,
    liveNetwork: false,
  });

  heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => logs.push(`adapter heartbeat: ${error.message}`));
  }, 2_000);
  let adapterClaims = 0;
  let adapterError = null;
  const pollAdapter = async () => {
    if (adapterError) return;
    try {
      const claim = await jsonPost(`${workerOrigin}/api/local/claim`, daemonToken, {
        operator: "acceptance-test-adapter",
      });
      if (!claim.envelope) return;
      adapterClaims += 1;
      const envelope = claim.envelope;
      adapterEvents.push({
        kind: "claimed",
        sandboxId: envelope.sandboxId,
        task: envelope.task,
        customAgentId: envelope.customAgentId,
        customAgentVersion: envelope.customAgentVersion,
        expectedDeliverables: envelope.expectedDeliverables,
      });
      const paths = envelope.expectedDeliverables ?? ["reports/acceptance.md"];
      const files = paths.map((filePath) => ({
        path: filePath,
        content: `# Deterministic acceptance output\n\n${managedContext ? `${managedContext.citation}\n\n` : ""}Task: ${envelope.task}\nEmployee: ${envelope.customAgentId}@v${envelope.customAgentVersion}\n`,
        encoding: "utf8",
      }));
      const result = await jsonPost(`${workerOrigin}/api/local/result`, daemonToken, {
        sandboxId: envelope.sandboxId,
        claimToken: claim.claimToken,
        result: {
          status: "completed",
          exitCode: 0,
          summary: "Fixture adapter returned deterministic text.",
          stderrTail: "",
          stdoutTail: "fixture adapter completed",
          changedFiles: paths,
          diff: paths
            .map(
              (filePath) =>
                `diff --git a/${filePath} b/${filePath}\n+deterministic acceptance output\n`,
            )
            .join(""),
          files,
          signals: [
            {
              kind: "exec.settled",
              at: Date.now(),
              detail: '{"command":"acceptance deterministic adapter","exit":0}',
            },
          ],
        },
      });
      adapterEvents.push({ kind: "settled", sandboxId: envelope.sandboxId, result });
    } catch (error) {
      adapterError = error instanceof Error ? error.message : String(error);
      logs.push(`adapter error: ${adapterError}`);
    }
  };
  adapterTimer = setInterval(() => {
    void pollAdapter();
  }, 400);

  await nav(page, "custom-agents");
  await page.getByRole("heading", { name: /Bots|Custom agents/ }).waitFor();
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByPlaceholder("security-reviewer").fill("acceptance-researcher");
  await page.getByPlaceholder("Security reviewer").fill("Acceptance Researcher");
  await page
    .getByPlaceholder("Standing instructions prepended to every run")
    .fill("Write the required deterministic acceptance report.");
  await page.getByLabel("Required deliverables").fill("reports/acceptance.md");
  await page.getByRole("button", { name: "Create bot" }).click();
  const employee = await waitFor("employee creation persists in the Worker store", async () => {
    const bots = await apiJson(page, "/api/custom-agents");
    return bots.agents.find((item) => item.config?.name === "Acceptance Researcher");
  });
  assert.ok(employee, "Created employee profile must persist in the Worker store.");
  const employeeVersion = employee.version;
  assert.equal(employee.config.expectedDeliverables[0], "reports/acceptance.md");
  checkpoints.push({
    id: "employee-create-reload",
    status: "passed",
    employeeId: employee.id,
    version: employeeVersion,
  });

  await nav(page, "collaboration");
  await page.getByRole("heading", { name: "Collaboration rooms" }).waitFor();
  await page.getByLabel("New room title").fill("Acceptance room");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name: "Acceptance room" }).waitFor();
  await page.getByLabel("Employee profile").selectOption(employee.id);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("li").filter({ hasText: "Acceptance Researcher · agent" }).waitFor();
  const createdRoom = (await apiJson(page, "/api/collaboration/rooms")).rooms.find(
    (item) => item.title === "Acceptance room",
  );
  assert.ok(createdRoom, "Room must be durable before adding the employee member.");
  const roomMemberState = await apiJson(
    page,
    `/api/collaboration/rooms/${encodeURIComponent(createdRoom.roomId)}`,
  );
  const employeeActorId = roomMemberState.members.find(
    (member) => member.actorKind === "agent",
  )?.actorId;
  assert.ok(employeeActorId, "Room employee must be bound to a real configured profile.");
  await page.getByLabel("Message").fill("Please review the acceptance report.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Please review the acceptance report.", { exact: true }).waitFor();
  await page.getByLabel("Task ID").fill("acceptance-room-task");
  await page
    .getByLabel("Employee task request")
    .fill("Review the acceptance report and summarize any gaps.");
  await page.getByLabel("Repository URL").fill("https://github.com/fixture/acceptance-repo");
  await page
    .locator(`select[aria-label="Employee execution target"] option[value="local:${machineId}"]`)
    .waitFor({ state: "attached" });
  await page.getByLabel("Employee execution target").selectOption(`local:${machineId}`);
  const roomRecipientSelect = page.getByLabel("Handoff recipient");
  await roomRecipientSelect.selectOption(employeeActorId);
  await page.getByRole("button", { name: "Request / create handoff" }).click();
  const queuedRoomHandoff = await waitFor("room employee handoff is persisted", async () => {
    const detail = await apiJson(
      page,
      `/api/collaboration/rooms/${encodeURIComponent(createdRoom.roomId)}`,
    );
    return detail.handoffs?.find((handoff) => handoff.taskId === "acceptance-room-task") ?? null;
  });
  assert.ok(
    queuedRoomHandoff.approvalId,
    `Room handoff must link its approval: ${JSON.stringify(queuedRoomHandoff)}`,
  );
  const roomApproval = await waitFor(
    "room employee work enters the existing approval queue",
    async () => {
      const approvals = await apiJson(page, "/api/approvals");
      return approvals.approvals?.find(
        (approval) => approval.approvalId === queuedRoomHandoff.approvalId,
      );
    },
  );
  assert.ok(roomApproval, "Room work must remain pending until explicitly approved.");
  assert.equal(adapterClaims, 0, "The room employee must not run before human approval.");
  const roomApprovalId = roomApproval.approvalId;
  const roomRequestRunCount = adapterClaims;
  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    "approved room employee task reaches deterministic adapter",
    () => adapterClaims > roomRequestRunCount,
  );
  const linkedRoomRun = await waitFor("room handoff links a completed run", async () => {
    const tasks = await apiJson(page, "/api/tasks");
    const revision = tasks.tasks?.find((task) =>
      task.attempts?.some((attempt) => attempt.approvalId === roomApprovalId),
    );
    const runId = revision?.attempts?.find(
      (attempt) => attempt.approvalId === roomApprovalId,
    )?.runId;
    if (!runId) return null;
    const result = await apiJson(page, `/api/runs/${encodeURIComponent(runId)}`);
    return result.run?.status === "completed" ? { task: revision, run: result.run } : null;
  });
  assert.equal(linkedRoomRun.run.customAgentId, employee.id);
  const roomsApi = await apiJson(page, "/api/collaboration/rooms");
  const room = roomsApi.rooms.find((item) => item.title === "Acceptance room");
  assert.ok(room, "Room must be durable in the Worker store.");
  await nav(page, "collaboration");
  await page.getByRole("heading", { name: "Acceptance room" }).waitFor();
  await page.getByText(/Completed approved task: acceptance-room-task/).waitFor();
  const roomApi = await apiJson(
    page,
    `/api/collaboration/rooms/${encodeURIComponent(room.roomId)}`,
  );
  assert.equal(roomApi.messages[0]?.body, "Please review the acceptance report.");
  const employeeReply = roomApi.messages.find((message) => message.senderKind === "agent");
  assert.ok(
    employeeReply,
    "A completed linked employee run must create a persisted employee reply.",
  );
  assert.equal(employeeReply.sourceRunId, linkedRoomRun.run.runId);
  assert.equal(employeeReply.sourceHandoffId, roomApi.handoffs[0]?.handoffId);
  assert.match(employeeReply.body, /Completed approved task: acceptance-room-task/);
  assert.match(employeeReply.body, /deterministic acceptance output/i);
  assert.equal(roomApi.handoffs[0]?.approvalId, roomApprovalId);
  assert.equal(roomApi.handoffs[0]?.runId, linkedRoomRun.run.runId);
  assert.equal(roomApi.handoffs[0]?.execution?.runStatus, "completed");
  await page.getByRole("button", { name: "Cancel handoff", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Acceptance room" }).waitFor();
  await page.getByText("Please review the acceptance report.", { exact: true }).waitFor();
  await page.getByText(employeeReply.body, { exact: true }).waitFor();
  const roomAfterReload = await apiJson(
    page,
    `/api/collaboration/rooms/${encodeURIComponent(room.roomId)}`,
  );
  assert.equal(roomAfterReload.handoffs[0]?.status, "cancelled");
  assert.equal(roomAfterReload.handoffs[0]?.execution?.runStatus, "completed");
  assert.equal(
    roomAfterReload.messages.filter((message) => message.sourceRunId === linkedRoomRun.run.runId)
      .length,
    1,
    "Polling and reload must not duplicate the employee reply.",
  );
  checkpoints.push({
    id: "room-employee-approval-result-cancel-reload",
    status: "passed",
    roomId: room.roomId,
    approvalId: roomApprovalId,
    taskId: linkedRoomRun.task.taskId,
    runId: linkedRoomRun.run.runId,
    employeeReplyMessageId: employeeReply.messageId,
    employeeReplyRunId: employeeReply.sourceRunId,
    employeeId: linkedRoomRun.run.customAgentId,
    cancelledAfterCompletion: true,
  });

  await nav(page, "tasks");
  // New threads start in chat-only mode. The task workflow is explicit and
  // requires the user to switch to Work before task controls are available.
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  const projectSource = await apiJson(page, "/api/memory/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Acceptance release notes",
      content: "Release context: verify the migration checklist before handoff.",
      kind: "note",
      referenceUrl: "https://docs.example.test/release-checklist",
      retentionDays: null,
    }),
  });
  const projectCreated = await apiJson(page, "/api/memory/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Acceptance release",
      purpose: "Prepare a safe self-hosted release.",
      sourceIds: [projectSource.source.id],
      defaultCustomAgentId: employee.id,
      defaultHarness: "opencode",
    }),
  });
  const projectId = projectCreated.project.id;
  // The project registry is loaded at app mount; reload to exercise the real
  // persisted project list rather than injecting an in-memory UI update.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await waitFor("new project context appears in Work intake", async () => {
    const projects = await apiJson(page, "/api/memory/projects");
    return projects.projects?.some((project) => project.id === projectId);
  });
  await waitFor("local paired computer visible to dashboard", async () => {
    const computers = await apiJson(page, "/api/computers");
    return computers.computers?.some(
      (computer) => computer.machineId === machineId && computer.status === "idle",
    );
  });
  const composer = page.getByTestId("task-composer");
  await composer.getByRole("combobox", { name: "Project context" }).selectOption(projectId);
  await composer.getByText("Snapshot freezes for approval; source text is untrusted.").waitFor();
  await composer.getByRole("button", { name: "Project: Select repository" }).click();
  await page
    .getByPlaceholder("https://github.com/owner/repo")
    .fill("https://github.com/fixture/acceptance-repo");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await composer.getByRole("button", { name: "Thread configuration" }).click();
  await page.getByRole("menuitemradio", { name: /Acceptance Researcher/ }).click();
  await page.keyboard.press("Escape");
  await composer.getByRole("button", { name: "Run on: Cloud" }).click();
  await page.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ }).click();
  const refreshPairedComputers = page.getByRole("button", { name: "Refresh paired computers" });
  // The target menu intentionally closes when Local is selected and only one
  // compatible computer is visible. Reopen it before refreshing; the fixture
  // may have one or two live paired machines depending on heartbeat timing.
  if (!(await refreshPairedComputers.isVisible().catch(() => false))) {
    await composer.getByRole("button", { name: "Run on: Local" }).click();
  }
  await refreshPairedComputers.click();
  const localComputer = composer.getByLabel("Local computer");
  await waitFor("fixture machine appears in the Work target selector", async () =>
    (await localComputer.locator(`option[value="${machineId}"]`).count()) > 0 &&
      await localComputer.isEnabled(),
  );
  await localComputer.selectOption(machineId);
  await composer.getByText("Local: acceptance-local-adapter", { exact: true }).waitFor();
  await composer.getByRole("button", { name: "Add to message" }).click();
  await page.getByRole("menuitem", { name: "Skills" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Acceptance research rules" }).click();
  await composer
    .getByLabel("Task description")
    .fill("Prepare the approved acceptance report using the attached reviewed skill.");
  const taskText = "Prepare the approved acceptance report using the attached reviewed skill.";
  const beforeMainTaskClaim = adapterClaims;
  await composer.getByRole("button", { name: "Send task" }).click();
  await page
    .getByRole("main")
    .getByText(/Queued — approve the run card to execute on this computer/)
    .waitFor();
  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
  const pendingApproval = await waitFor(
    "the exact task appears in the pending approval payload",
    async () => {
      const approvalApi = await apiJson(page, "/api/approvals");
      return approvalApi.approvals.find((approval) => JSON.stringify(approval).includes(taskText));
    },
  );
  assert.ok(
    pendingApproval,
    "The pending approval must freeze the exact task text before execution.",
  );
  const projectFrozenPayload = JSON.stringify(pendingApproval);
  assert.ok(
    projectFrozenPayload.includes("Acceptance release"),
    "Approval must freeze the selected project name.",
  );
  assert.ok(
    projectFrozenPayload.includes("Prepare a safe self-hosted release."),
    "Approval must freeze project purpose.",
  );
  assert.ok(
    projectFrozenPayload.includes("verify the migration checklist before handoff"),
    "Approval must freeze selected source text.",
  );
  assert.ok(
    projectFrozenPayload.includes("https://docs.example.test/release-checklist"),
    "Approval must retain source provenance.",
  );
  assert.ok(
    projectFrozenPayload.includes("UNTRUSTED REFERENCE DATA"),
    "Frozen source text must be framed as untrusted data.",
  );
  await apiJson(page, `/api/memory/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "Changed after this approval was created.", expectedVersion: (await apiJson(page, `/api/memory/projects/${encodeURIComponent(projectId)}`)).project.version }),
  });
  const approvedPayload = JSON.stringify(pendingApproval);
  assert.ok(approvedPayload.includes(employee.id), "Approval must freeze the employee identity.");
  assert.ok(
    approvedPayload.includes(String(employeeVersion)),
    "Approval must freeze the employee version.",
  );
  assert.ok(
    approvedPayload.includes(activeSkill.id),
    "Approval must freeze the reviewed skill identity.",
  );
  assert.ok(
    approvedPayload.includes(`"version":${activeSkill.version}`),
    "Approval must freeze the reviewed skill version.",
  );
  assert.equal(
    adapterClaims,
    beforeMainTaskClaim,
    "The local adapter must not receive work before the human approval click.",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    "deterministic adapter receives approved run",
    () => adapterClaims > beforeMainTaskClaim,
  );
  await waitFor("approved employee task completes in the real orchestrator DO", async () => {
    if (adapterError) throw new Error(adapterError);
    const runs = await apiJson(page, "/api/runs");
    return runs.runs?.find((run) => run.task?.includes(taskText) && run.status === "completed");
  });
  const runList = await apiJson(page, "/api/runs");
  const completedRun = runList.runs.find(
    (run) => run.task?.includes(taskText) && run.status === "completed",
  );
  assert.equal(completedRun.customAgentId, employee.id);
  assert.ok(
    completedRun.task.includes("Prepare a safe self-hosted release."),
    "Dispatch must retain the approved project snapshot after the project is edited.",
  );
  assert.ok(
    !completedRun.task.includes("Changed after this approval was created."),
    "Dispatch must not silently replace the approved project snapshot.",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await nav(page, "tasks");
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await page
    .getByRole("main")
    .getByText(/Prepare a safe self-hosted release\./)
    .waitFor();
  const persistedProject = await apiJson(
    page,
    `/api/memory/projects/${encodeURIComponent(projectId)}`,
  );
  assert.equal(persistedProject.project.purpose, "Changed after this approval was created.");
  checkpoints.push({
    id: "project-context-approval-run-reload",
    status: "passed",
    projectId,
    sourceId: projectSource.source.id,
    runId: completedRun.runId,
    frozenPurposeSurvivedEdit: true,
    reloadedProjectVersion: persistedProject.project.version,
  });
  await nav(page, "tasks");
  const reviewDecision = page.getByLabel("Review decision for reports/acceptance.md");
  await reviewDecision.waitFor();
  await reviewDecision.selectOption("changes_requested");
  const revisionNote = "Include a brief self-hosting limitation note.";
  await page.getByLabel("Revision note for reports/acceptance.md").fill(revisionNote);
  await page.getByRole("button", { name: "Save review" }).click();
  await page.getByRole("status").filter({ hasText: "Revision requested." }).waitFor();
  const reviewedHistory = await apiJson(
    page,
    `/api/runs/${encodeURIComponent(completedRun.runId)}/deliverables/0/history`,
  );
  assert.equal(reviewedHistory.versions?.[0]?.review.status, "changes_requested");
  assert.equal(reviewedHistory.versions?.[0]?.review.note, revisionNote);
  assert.equal(reviewedHistory.versions?.[0]?.review.revision, 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(`Current saved review: changes requested · ${revisionNote}`, { exact: true }).waitFor();
  const reviewAfterReload = await apiJson(
    page,
    `/api/runs/${encodeURIComponent(completedRun.runId)}/deliverables/0/history`,
  );
  assert.equal(reviewAfterReload.versions?.[0]?.review.status, "changes_requested");
  assert.equal(reviewAfterReload.versions?.[0]?.review.note, revisionNote);
  assert.equal(reviewAfterReload.versions?.[0]?.review.revision, 1);
  const sourceTask = (await apiJson(page, "/api/tasks")).tasks?.find((task) =>
    task.attempts?.some((attempt) => attempt.runId === completedRun.runId),
  );
  assert.ok(sourceTask, "Completed run must be retained in durable task history.");
  await page.getByRole("button", { name: "Create revision approval" }).click();
  const revisionTask = await waitFor(
    "artifact revision creates a new linked approval task",
    async () => {
      const tasks = await apiJson(page, "/api/tasks");
      return tasks.tasks?.find((task) => task.revisionOf?.runId === completedRun.runId) ?? null;
    },
  );
  assert.notEqual(revisionTask.taskId, sourceTask.taskId, "Revision work must be a new task.");
  assert.equal(revisionTask.revisionOf?.taskId, sourceTask.taskId);
  const revisionApprovalId = revisionTask.attempts?.at(-1)?.approvalId;
  assert.ok(revisionApprovalId, "Revision task must require a fresh approval.");
  const beforeRevisionClaim = adapterClaims;
  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
  const revisionApproval = await waitFor("revision task appears in Approvals", async () => {
    const approvals = await apiJson(page, "/api/approvals");
    return (
      approvals.approvals?.find((approval) => approval.approvalId === revisionApprovalId) ?? null
    );
  });
  assert.ok(JSON.stringify(revisionApproval).includes(revisionNote));
  assert.equal(
    adapterClaims,
    beforeRevisionClaim,
    "Revision work must remain gated until approved.",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor(
    "approved revision reaches the deterministic local adapter",
    () => adapterClaims > beforeRevisionClaim,
  );
  const revisionRun = await waitFor("revision run produces its new artifact", async () => {
    const tasks = await apiJson(page, "/api/tasks");
    const current = tasks.tasks?.find((task) => task.taskId === revisionTask.taskId);
    const runId = current?.attempts?.find(
      (attempt) => attempt.approvalId === revisionApprovalId,
    )?.runId;
    if (!runId) return null;
    const result = await apiJson(page, `/api/runs/${encodeURIComponent(runId)}`);
    return result.run?.status === "completed" ? { task: current, run: result.run } : null;
  });
  assert.equal(revisionRun.run.customAgentId, employee.id);
  const revisedHistory = await apiJson(
    page,
    `/api/runs/${encodeURIComponent(revisionRun.run.runId)}/deliverables/0/history`,
  );
  assert.deepEqual(
    revisedHistory.versions.map((version) => version.version),
    [1, 2],
  );
  assert.equal(revisedHistory.versions[0].runId, completedRun.runId);
  assert.equal(revisedHistory.versions[1].runId, revisionRun.run.runId);
  assert.equal(revisedHistory.versions[1].artifactId, reviewedHistory.versions[0].artifactId);
  const previousVersion = await page.evaluate(
    async ({ runId, index }) => {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/deliverables/${index}`);
      return { status: response.status, text: await response.text() };
    },
    { runId: completedRun.runId, index: 0 },
  );
  assert.equal(previousVersion.status, 200);
  assert.match(previousVersion.text, /Deterministic acceptance output/);
  checkpoints.push({
    id: "artifact-review-revision-reload",
    status: "passed",
    runId: completedRun.runId,
    revisionTaskId: revisionTask.taskId,
    revisionApprovalId,
    revisionRunId: revisionRun.run.runId,
    reviewStatus: "changes_requested",
    revisionNote,
    historyVersions: revisedHistory.versions.length,
    priorVersionRetained: previousVersion.status === 200,
  });
  assert.ok(
    completedRun.signals?.some(
      (signal) =>
        signal.kind === "exec.settled" &&
        signal.detail?.includes("acceptance deterministic adapter"),
    ),
    "Run must retain the local executor receipt.",
  );
  const deliverable = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/deliverables/0`);
    return { status: response.status, text: await response.text() };
  }, completedRun.runId);
  assert.equal(deliverable.status, 200);
  assert.match(deliverable.text, /Deterministic acceptance output/);
  checkpoints.push({
    id: "employee-task-approval-receipt-artifact",
    status: "passed",
    runId: completedRun.runId,
    approvalId: completedRun.approval?.approvalId,
    employeeId: completedRun.customAgentId,
    employeeVersion,
    skillPins: [{ skillId: activeSkill.id, version: activeSkill.version }],
    receipt: completedRun.signals.find((signal) => signal.kind === "exec.settled"),
    deliverablePath: completedRun.deliverables?.[0]?.path,
    deliverableBytes: deliverable.text.length,
  });

  // Transport fault only: exercise the installed useAgentChat onError + resolved promise
  // without forwarding this synthetic app task to any model or connected app.
  let pendingAppFailure;
  let appFailureRequests = 0;
  await context.routeWebSocket("**/agents/**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      let frame;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      const body = frame.type === "cf_agent_use_chat_request" ? JSON.parse(frame.init.body) : null;
      const turn = body?.messages?.at(-1);
      if (turn?.metadata?.shibaWorkTarget === "app-tools") {
        appFailureRequests += 1;
        pendingAppFailure = () => socket.send(JSON.stringify({ type: "cf_agent_use_chat_response", id: frame.id, error: true, body: "Synthetic callback stream error" }));
      } else server.send(message);
    });
  });
  await apiJson(page, "/api/custom-agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "acceptance-callback-bot", config: { name: "Acceptance Callback Bot", instructions: "Synthetic transport fixture only.", harness: "opencode" } }) });
  await nav(page, "tasks");
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await page.getByRole("button", { name: "Configure Research employee", exact: true }).click();
  await page.getByRole("region", { name: "Return to first task setup" }).waitFor();
  assert.equal((await apiJson(page, "/api/custom-agents")).agents.length, 2, "Configuring a suggestion only opens the existing editor.");
  await page.getByRole("button", { name: "Choose saved employee in setup", exact: true }).click();
  await page.getByText("Use an existing employee", { exact: true }).click();
  await page.getByRole("button", { name: "Acceptance Callback Bot · v1", exact: true }).click();
  await page.getByRole("button", { name: "Create first task draft", exact: true }).click();
  await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
  await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
  const replaceCallbackDraft = page.getByRole("button", { name: "Replace with saved draft", exact: true });
  if (await replaceCallbackDraft.isVisible()) await replaceCallbackDraft.click();
  await nav(page, "custom-agents");
  await page.getByRole("button", { name: "Launch bot Acceptance Callback Bot", exact: true }).click();
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
  await page.getByRole("combobox", { name: "Work target", exact: true }).selectOption("app-tools");
  const callbackInput = page.getByRole("textbox", { name: "Task description" });
  const callbackCanonicalTask = await callbackInput.inputValue();
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await waitFor("synthetic app turn reaches the real chat transport", () => appFailureRequests === 1 && pendingAppFailure);
  pendingAppFailure(); pendingAppFailure = null;
  await waitFor("onError with a resolved send promise restores the task", async () => (await callbackInput.inputValue()) === callbackCanonicalTask);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  await waitFor("second synthetic app turn reaches transport", () => appFailureRequests === 2 && pendingAppFailure);
  await callbackInput.fill("Newer unsent text must win.");
  pendingAppFailure(); pendingAppFailure = null;
  await waitFor("failed send settles", async () => (await page.getByRole("button", { name: "Sending…", exact: true }).count()) === 0);
  assert.equal(await callbackInput.inputValue(), "Newer unsent text must win.");
  assert.equal(appFailureRequests, 2, "Callback errors must never automatically retry a user turn.");
  checkpoints.push({ id: "app-tools-callback-error-unsent-recovery", status: "passed", installedChatHook: true, transportFaultInjected: true, sourceToolCalled: false, modelCalled: false, restoredAfterCallbackError: true, newerEditPreserved: true, sends: appFailureRequests });
  await callbackInput.fill("");

  // Real private upload/CAS/isolation proof, then visible source selection in the saved goal.
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const otherOwnerPage = await otherContext.newPage();
  await otherOwnerPage.goto(`${workerOrigin}/app/`, { waitUntil: "domcontentloaded" });
  await otherOwnerPage.getByLabel("Email").fill("acceptance-other@example.test");
  await otherOwnerPage.getByLabel("Password").fill("e2e-password-2026!");
  await otherOwnerPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitFor("second authenticated owner session", async () => (await apiJson(otherOwnerPage, "/api/auth/get-session")).user?.email === "acceptance-other@example.test");
  managedContext = await runManagedContextProof({ page, origin: workerOrigin, api: (url, init) => apiJson(page, url, init), report: (checkpoint) => checkpoints.push(checkpoint), fixture: { otherOwnerPage } });
  await otherContext.close();
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await nav(page, "tasks");
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit employee", exact: true }).click();
  await page.getByRole("textbox", { name: "Your answer: Employee" }).waitFor();
  await page.getByText("Use an existing employee", { exact: true }).click();
  await page.getByRole("button", { name: `Acceptance Researcher · v${employeeVersion}`, exact: true }).click();
  await page.getByRole("region", { name: "First task draft review" }).waitFor();
  await page.getByRole("button", { name: "Edit context", exact: true }).click();
  const contextAnswer = page.getByRole("textbox", { name: "Your answer: Context" });
  const groundedFacts = "Prepare a reviewable report from the selected private source. Do not send or publish.";
  await contextAnswer.fill(groundedFacts);
  const selectedSource = page.getByRole("checkbox", { name: `${managedContext.sourceTitle} · v3 · ready`, exact: true });
  await selectedSource.click();
  await waitFor("source id saved in the goal", async () => (await apiJson(page, "/api/onboarding/progress")).draftTask.sourceIds.includes(managedContext.source.id));
  await waitFor("saved source selection is reflected in the picker", () => selectedSource.isChecked());
  assert.equal(await contextAnswer.inputValue(), groundedFacts, "Selecting sources preserves the unsent answer.");
  await page.getByRole("button", { name: "Upload or manage sources, then return", exact: true }).click();
  await page.getByRole("region", { name: "Workspace memory sources" }).waitFor();
  await nav(page, "tasks");
  await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
  await contextAnswer.waitFor();
  assert.equal(await contextAnswer.inputValue(), groundedFacts);
  assert.equal(await selectedSource.isChecked(), true);
  await contextAnswer.press("Control+Enter");
  await page.getByRole("region", { name: "First task draft review" }).waitFor();
  await page.getByRole("button", { name: "Create first task draft", exact: true }).click();
  await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
  const sourceGoal = await apiJson(page, "/api/onboarding/progress");
  assert.equal(sourceGoal.draftTask.employeeId, employee.id);
  assert.equal(sourceGoal.draftTask.employeeVersion, employeeVersion);
  assert.deepEqual(sourceGoal.draftTask.sourceRefs, managedContext.sourceRefs);
  await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
  // The earlier ordinary task may still be unsent; replacement is explicit.
  const replaceGoal = page.getByRole("button", { name: "Replace with saved draft", exact: true });
  if (await replaceGoal.isVisible()) await replaceGoal.click();
  await composer.getByRole("combobox", { name: "Project context" }).selectOption("");
  await composer.getByRole("button", { name: /^Project: / }).click();
  await page.getByPlaceholder("https://github.com/owner/repo").fill("https://github.com/fixture/acceptance-repo");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await composer.getByRole("button", { name: "Thread configuration" }).click();
  await page.getByRole("menuitemradio", { name: /Acceptance Researcher/ }).click();
  await page.keyboard.press("Escape");
  await composer.getByRole("button", { name: "Run on: Cloud" }).click();
  await page.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ }).focus();
  await page.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ }).press("Enter");
  if (!(await page.getByRole("button", { name: "Refresh paired computers" }).isVisible().catch(() => false))) await composer.getByRole("button", { name: "Run on: Local" }).click();
  await page.getByRole("button", { name: "Refresh paired computers" }).click();
  await composer.getByLabel("Local computer").selectOption(machineId);
  await page.keyboard.press("Escape");
  const beforeGoalClaims = adapterClaims;
  const goalQueued = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await composer.getByRole("button", { name: "Send task", exact: true }).click();
  const queuedGoalResponse = await goalQueued;
  assert.equal(queuedGoalResponse.status(), 200);
  const goalSessionId = new URL(queuedGoalResponse.url()).searchParams.get("session");
  const goalQuery = goalSessionId ? `?${new URLSearchParams({ session: goalSessionId })}` : "";
  const goalApproval = await waitFor("source-bound first goal approval", async () => (await apiJson(page, `/api/approvals${goalQuery}`)).approvals.find((item) => item.draftTaskId === sourceGoal.draftTaskId && item.draftTaskVersion === sourceGoal.draftTask.version));
  const boundGoal = { draftTaskId: sourceGoal.draftTaskId, version: sourceGoal.draftTask.version, approvalId: goalApproval.approvalId, sessionId: goalSessionId };
  await verifyManagedContextApproval({ page, api: (url, init) => apiJson(page, url, init), report: (checkpoint) => checkpoints.push(checkpoint), context: managedContext, goal: boundGoal });
  assert.equal(adapterClaims, beforeGoalClaims, "The prepared goal must still wait for explicit approval.");
  assert.equal((await apiJson(page, "/api/onboarding/progress")).activatedAt, null, "An unrelated approved artifact must not activate this goal.");
  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const goalRun = await waitFor("source-bound first goal artifact", async () => (await apiJson(page, `/api/runs${goalQuery}`)).runs.find((item) => item.draftTaskId === boundGoal.draftTaskId && item.draftTaskVersion === boundGoal.version && item.status === "completed"));
  boundGoal.runId = goalRun.runId;
  await verifyManagedContextDraft({ page, api: (url, init) => apiJson(page, url, init), report: (checkpoint) => checkpoints.push(checkpoint), context: managedContext, goal: boundGoal });
  await nav(page, "tasks");
  await page.getByLabel("Review decision for reports/acceptance.md").selectOption("approved");
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await waitFor("the exact current goal activates after human acceptance", async () => (await apiJson(page, "/api/onboarding/progress")).activatedAt !== null);
  checkpoints.push({ id: "onboarding-source-goal-configure-return-accept", status: "passed", ...boundGoal, employeeId: employee.id, sourceRefs: managedContext.sourceRefs, explicitPrepare: true, explicitApproval: true, explicitAcceptance: true, automaticExternalActions: false });

  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Approvals", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Waiting", exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Approvals", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Waiting", exact: true }).waitFor();
  assert.deepEqual(
    externalFontRequests,
    [],
    "Dashboard and approvals reload must remain local-only.",
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  evidence.screenshots.push(screenshotPath);
  evidence.status = "passed";
} catch (error) {
  evidence.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  if (browser) {
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages[0]) {
        await pages[0].screenshot({ path: screenshotPath, fullPage: true });
        evidence.screenshots.push(screenshotPath);
      }
    } catch {}
  }
} finally {
  await stopAll();
  evidence.adapterEvents = adapterEvents;
  evidence.browserEvents = browserEvents.slice(-160);
  evidence.workerLogs = logs.slice(-120);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Browser journey evidence: ${evidencePath}`);
  console.log(`Browser journey ${evidence.status.toUpperCase()}`);
  if (evidence.error) console.error(evidence.error);
  await rm(tempRoot, { recursive: true, force: true });
}

if (evidence.status !== "passed") process.exitCode = 1;
