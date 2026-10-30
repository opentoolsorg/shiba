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
    const response = await fetch(`${workerOrigin}/app/`, { redirect: "manual" }).catch(() => null);
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

  await nav(page, "integrations");
  await page.getByRole("heading", { name: "Integrations" }).waitFor();
  await page.getByRole("heading", { name: "Reason Network (OSS)" }).waitFor();
  await page.getByLabel("Reason conversation ID").fill("acceptance-reason-conversation");
  await page.getByLabel("Reason session ID").fill("acceptance-reason-session");
  await page.getByRole("button", { name: "Create local grant" }).click();
  await page
    .getByText(/acceptance-reason-conversation · acceptance-reason-session · active/)
    .waitFor();
  await page.getByLabel("Exact peer destination").fill("peer:acceptance");
  await page.getByLabel("Exact message for approval").fill("This is an approval record only.");
  await page.getByRole("button", { name: "Request approval record" }).click();
  await page.getByText("This is an approval record only.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Approve record" }).click();
  await waitFor("Reason Network approval is stored without dispatch", async () => {
    const [status, approvals] = await Promise.all([
      apiJson(page, "/api/reason-network/status"),
      apiJson(page, "/api/reason-network/approvals?status=approved"),
    ]);
    return (
      status.enabled === false &&
      status.dispatchConfigured === false &&
      approvals.approvals?.some(
        (approval) => approval.message === "This is an approval record only.",
      )
    );
  });
  const reasonStatus = await apiJson(page, "/api/reason-network/status");
  checkpoints.push({
    id: "reason-network-approval-setup-disabled",
    status: "passed",
    readiness: reasonStatus.state,
    enabled: reasonStatus.enabled,
    dispatchConfigured: reasonStatus.dispatchConfigured,
    activeGrants: reasonStatus.activeGrants,
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
    body: JSON.stringify({ purpose: "Changed after this approval was created." }),
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
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(`Review: changes requested · ${revisionNote}`, { exact: true }).waitFor();
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
