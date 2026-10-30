import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const backendDir = path.join(root, "apps/backend");
const frontendDir = path.join(root, "apps/frontend");
const workerPort = process.env.SHIBA_ACCEPTANCE_PORT ?? "8788";
const workerOrigin = `http://localhost:${workerPort}`;
const workerLoopbackOrigin = `http://127.0.0.1:${workerPort}`;
const tempRoot = await mkdtemp(path.join(tmpdir(), "shiba-browser-acceptance-"));
const stateDir = path.join(tempRoot, "wrangler-state");
const screenshotDir = path.join(tmpdir(), "shiba-e2e-acceptance", "screenshots");
const screenshotPath = path.join(screenshotDir, `${path.basename(tempRoot)}-journey.png`);
await mkdir(screenshotDir, { recursive: true });
const evidencePath = path.join(tmpdir(), "shiba-e2e-acceptance", "browser.latest.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

const varsPath = path.join(backendDir, ".dev.vars");
let varsOwned = false;
const children = [];
const logs = [];
const checkpoints = [];
const adapterEvents = [];
let adapterTimer;
let heartbeatTimer;
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
    const response = await fetch(`${workerOrigin}/app/`, { redirect: "manual" }).catch(
      () => null,
    );
    return response?.status === 200 && new URL(response.url).origin === workerOrigin;
  });

  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { chromium } = desktopRequire("playwright-core");
  browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => logs.push(`browser pageerror: ${error.message}`));
  await page.goto(`${workerOrigin}/app/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "First sign-in? Create the account" }).click();
  await page.getByLabel("Name").fill("Shiba Acceptance Owner");
  await page.getByLabel("Email").fill("acceptance-owner@example.test");
  await page.getByLabel("Password").fill("e2e-password-2026!");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
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
  await page.getByRole("heading", { name: "Your agent" }).waitFor();
  checkpoints.push({
    id: "onboarding-close-reload-resume",
    status: "passed",
    currentStep: afterDismiss.currentStep,
    revision: afterDismiss.revision,
  });
  await page.getByRole("button", { name: "Close setup" }).click();

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

  await nav(page, "collaboration");
  await page.getByRole("heading", { name: "Collaboration rooms" }).waitFor();
  await page.getByLabel("New room title").fill("Acceptance room");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name: "Acceptance room" }).waitFor();
  await page.getByRole("button", { name: "Add agent participant" }).click();
  await page.getByLabel("Message").fill("Persist this test message.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Persist this test message.", { exact: true }).waitFor();
  await page.getByLabel("Task ID").fill("acceptance-task");
  const recipients = page.getByLabel("Handoff recipient");
  const agentOption = await recipients
    .locator("option")
    .evaluateAll(
      (options) =>
        options.find((option) => option.textContent?.includes("Agent · agent"))?.value ?? null,
    );
  assert.ok(agentOption, "Adding an agent should expose it as a handoff recipient.");
  await recipients.selectOption(agentOption);
  await page.getByRole("button", { name: "Create handoff" }).click();
  await page.getByText("acceptance-task", { exact: true }).waitFor();
  const roomsApi = await apiJson(page, "/api/collaboration/rooms");
  const room = roomsApi.rooms.find((item) => item.title === "Acceptance room");
  assert.ok(room, "Room must be durable in the Worker store.");
  const roomApi = await apiJson(
    page,
    `/api/collaboration/rooms/${encodeURIComponent(room.roomId)}`,
  );
  assert.equal(roomApi.messages[0]?.body, "Persist this test message.");
  assert.equal(roomApi.handoffs[0]?.taskId, "acceptance-task");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Acceptance room" }).waitFor();
  await page.getByText("Persist this test message.", { exact: true }).waitFor();
  checkpoints.push({
    id: "room-message-handoff-reload",
    status: "passed",
    roomId: room.roomId,
    handoffId: roomApi.handoffs[0].handoffId,
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
    });
  await heartbeat();
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
        content: `# Deterministic acceptance output\n\nTask: ${envelope.task}\nEmployee: ${envelope.customAgentId}@v${envelope.customAgentVersion}\n`,
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

  await nav(page, "tasks");
  // New threads start in chat-only mode. The task workflow is explicit and
  // requires the user to switch to Work before task controls are available.
  await page.getByRole("tab", { name: "Work", exact: true }).click();
  await waitFor("local paired computer visible to dashboard", async () => {
    const computers = await apiJson(page, "/api/computers");
    return computers.computers?.some(
      (computer) => computer.machineId === machineId && computer.status === "idle",
    );
  });
  const composer = page.getByTestId("task-composer");
  await composer.getByRole("button", { name: "Project: Select repository" }).click();
  await page
    .getByPlaceholder("https://github.com/owner/repo")
    .fill("https://github.com/fixture/acceptance-repo");
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await composer.getByRole("button", { name: "Thread configuration" }).click();
  await page.getByRole("menuitemradio", { name: /Acceptance Researcher/ }).click();
  await composer.getByRole("button", { name: "Run on: Cloud" }).click();
  await page.getByRole("menuitemradio", { name: /Local \(Paired computer\)/ }).click();
  await composer.getByText("Local: acceptance-local-adapter", { exact: true }).waitFor();
  await composer.getByRole("button", { name: "Add to message" }).click();
  await page.getByRole("menuitem", { name: "Skills" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Acceptance research rules" }).click();
  await composer
    .getByLabel("Task description")
    .fill("Prepare the approved acceptance report using the attached reviewed skill.");
  const taskText = "Prepare the approved acceptance report using the attached reviewed skill.";
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
    0,
    "The local adapter must not receive work before the human approval click.",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await waitFor("deterministic adapter receives approved run", () => adapterClaims > 0);
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

  await page.goto(`${workerOrigin}/approvals/`, { waitUntil: "domcontentloaded" });
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
  evidence.workerLogs = logs.slice(-120);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Browser journey evidence: ${evidencePath}`);
  console.log(`Browser journey ${evidence.status.toUpperCase()}`);
  if (evidence.error) console.error(evidence.error);
  await rm(tempRoot, { recursive: true, force: true });
}

if (evidence.status !== "passed") process.exitCode = 1;
