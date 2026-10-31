#!/usr/bin/env node
/** Agent lifecycle in a real local Worker; execution alone uses the declared stand-in. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { containersMode, githubMode, readPort, standinMode, waitFor } from "./journey-lib.mjs";
import { launchLifecycleTarget } from "./lifecycle-target.mjs";

assert.equal(process.env.VERIFY_AGENT_LIFECYCLE_MOCK, "1", "Set VERIFY_AGENT_LIFECYCLE_MOCK=1 for the explicitly synthetic execution journey.");
assert.equal(githubMode(), "mock");
assert.equal(containersMode(), "disabled");
assert.equal(standinMode(), "enabled");
const base = new URL(process.env.VERIFY_APP_URL ?? "http://127.0.0.1:8790");
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Lifecycle fixtures must target loopback.");
assert.equal(base.protocol, "http:", "Use the local harness HTTP listener.");
assert.equal(base.port, readPort(), "Lifecycle target must match the recorded mock Worker port.");
const output = resolve(process.env.VERIFY_DESKTOP === "1" ? ".verify/desktop-agent-lifecycle" : ".verify/agent-lifecycle");
mkdirSync(output, { recursive: true });
const report = {
  mode: "real local Bots UI/auth/API/D1; composer submission and human approval UI; synthetic execution; mock GitHub",
  steps: [],
  status: "RUNNING",
};
writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2));
const target = await launchLifecycleTarget(base, chromium);
report.target = target.target;
if (target.desktopEvidence) report.desktop = target.desktopEvidence;
const context = target.context;
await context.tracing.start({ screenshots: true, snapshots: true });
const page = target.page;
page.setDefaultTimeout(30_000);
const stamp = Date.now();
const slug = `lifecycle-${stamp}`;
const name = `Lifecycle auditor ${stamp}`;
const model = "google/gemini-3.5-flash-lite";
const task = `verify-shiba lifecycle: inspect README ${stamp}`;
const instructions = (version) => `Lifecycle fixture ${stamp}: approved instructions version ${version}. Require human approval.`;
const passed = (step) => {
  report.steps.push({ step, status: "PASS" });
  writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(`PASS ${step}`);
};
const snapshot = (value) => ({
  customAgentId: value.customAgentId,
  customAgentVersion: value.customAgentVersion,
  task: value.task,
  route: value.route,
  sandboxProvider: value.sandboxProvider,
});
let agentId;
let sessionId;
let approvalId;
let runId;
let stage = "create";

async function json(path) {
  const response = await page.request.get(new URL(path, base).href);
  assert(response.ok(), `GET ${path} returned ${response.status()}: ${await response.text()}`);
  return response.json();
}
const card = () => page.locator("li").filter({ hasText: slug }).first();
async function directory(archived = false) {
  await page.goto(new URL("/app/", base).href);
  await page.getByRole("navigation", { name: "Main", exact: true }).locator('button[aria-haspopup="true"]').click();
  await page.getByRole("menuitem", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: archived ? "Archived bots" : "Active bots", exact: true }).click();
}
async function editProfile(version) {
  await directory();
  await card().getByRole("button", { name: "Edit bot", exact: true }).click();
  await page.getByLabel(/^Instructions/).fill(instructions(version));
  await page.getByLabel("Model", { exact: true }).fill(version === 3 ? "openai/gpt-6-sol" : model);
  const savedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/custom-agents/${agentId}`) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const saved = await savedResponse;
  assert.equal(saved.status(), 200, await saved.text());
  const body = await saved.json();
  assert.equal(body.agent.version, version);
  assert.equal(body.agent.config.instructions, instructions(version));
  return body.agent;
}
async function pending() {
  const body = await json("/api/approvals");
  return body.approvals.find((item) => item.approvalId === approvalId);
}

try {
  await directory();
  await page.getByLabel("Slug", { exact: true }).fill(slug);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel(/^Instructions/).fill(instructions(1));
  await page.getByLabel("Harness", { exact: true }).fill("opencode");
  await page.getByLabel("Model", { exact: true }).fill(model);
  await page.getByRole("combobox", { name: /^Model connection/ }).selectOption("");
  await page.getByLabel("Default repository", { exact: true }).fill("https://github.com/cloudflare/ai-chat");
  const createResponse = page.waitForResponse((response) => response.url().endsWith("/api/custom-agents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  const created = await createResponse;
  assert.equal(created.status(), 201, await created.text());
  const { agent } = await created.json();
  agentId = agent.id;
  assert.equal(agent.version, 1);
  assert.equal(agent.config.codingModel, model);
  assert.equal(agent.config.harness, "opencode");
  assert.equal(agent.config.connectionId, undefined);
  passed("Create a configured bot through the UI; persist harness, model, instructions, and repository");

  stage = "edit";
  const edited = await editProfile(2);
  const persisted = await json(`/api/custom-agents/${agentId}`);
  assert.deepEqual(persisted.agent.config, edited.config);
  await page.reload();
  await card().getByRole("button", { name: "Edit bot", exact: true }).click();
  assert.equal(await page.getByLabel("Model", { exact: true }).inputValue(), model);
  assert.equal(await page.getByLabel(/^Instructions/).inputValue(), instructions(2));
  passed("Edit to version 2 and verify profile controls survive refresh");

  stage = "thread";
  await directory();
  const sessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: `Launch bot ${name}`, exact: true }).click();
  const sessionCreated = await sessionResponse;
  assert.equal(sessionCreated.status(), 201, await sessionCreated.text());
  const { session } = await sessionCreated.json();
  sessionId = session.id;
  assert.equal(session.metadata.customAgentId, agentId);
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  await page.getByLabel("Task description", { exact: true }).fill(task);
  await directory();
  const resumeResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/sessions/${encodeURIComponent(sessionId)}/resume` &&
    response.request().method() === "POST",
  );
  await card().getByRole("list", { name: `${name} threads`, exact: true }).getByRole("button").filter({ hasText: name }).first().click();
  assert.equal((await resumeResponse).status(), 200, "Reopening a bot conversation must resume its named session");
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  passed("Launch a bot conversation and reopen it from the bot's own thread history");

  stage = "queue";
  const composer = page.getByLabel("Task description", { exact: true });
  await composer.fill(task);
  let failedSubmission;
  const failFirstQueue = async (route) => {
    const request = route.request();
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/runs" && !failedSubmission) {
      failedSubmission = request.postDataJSON();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Bot launch temporary outage" }) });
    } else await route.continue();
  };
  await page.route("**/api/runs**", failFirstQueue);
  const queueResponse = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  const failedResponse = queueResponse();
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  assert.equal((await failedResponse).status(), 503);
  await page.getByText(/Bot launch temporary outage/).first().waitFor();
  assert.equal(await composer.inputValue(), task);
  assert.equal(typeof failedSubmission.commandId, "string");
  const afterFailure = await json("/api/approvals");
  assert(!afterFailure.approvals.some((item) => item.task.endsWith(task)), "A failed queue request must not mint an approval");
  await page.unroute("**/api/runs**", failFirstQueue);
  // The 503 UI restores the draft asynchronously. Wait for the composer to be
  // actionable before exercising its retry path, rather than racing React's
  // submission-state cleanup with a second click.
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Send task"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  passed("A failed bot submission shows the error, restores the draft, and creates no approval");

  const realResponse = queueResponse();
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  const queued = await realResponse;
  const actualRequest = queued.request();
  const submitted = actualRequest.postDataJSON();
  assert.equal(new URL(actualRequest.url()).searchParams.get("session"), sessionId);
  assert.equal(submitted.customAgentId, agentId);
  assert.equal(submitted.task, task);
  assert.equal(submitted.repoUrl, "https://github.com/cloudflare/ai-chat");
  assert.equal(submitted.harness, "opencode");
  assert.equal(submitted.codingModel, model);
  assert.equal(submitted.runtime, "sandbox");
  assert.equal(submitted.targetMachineId, undefined);
  assert.equal(submitted.baseBranch, "main");
  assert.equal(submitted.publishPullRequest, false);
  assert.equal(submitted.commandId, failedSubmission.commandId, "Retry must preserve its original command ID");
  report.submission = { source: "composer UI", method: actualRequest.method(), session: sessionId, ...submitted };
  assert(queued.ok(), `Queue failed ${queued.status()}`);
  // The UI intentionally does not consume the success body. Read the actual
  // persisted approval instead of waiting on an unconsumed browser fetch body.
  const approvedInput = await waitFor("the UI-submitted bot approval", async () => {
    const body = await json("/api/approvals");
    return body.approvals.find((item) => item.customAgentId === agentId && item.task === `${instructions(2)}\n\n---\n\n${task}`);
  }, { timeoutMs: 15_000, intervalMs: 250 });
  approvalId = approvedInput.approvalId;
  assert.equal(typeof approvalId, "string");
  runId = `agent-tool:${approvalId}`;
  assert(approvedInput, "Queue must create a pending approval");
  assert.equal(approvedInput.threadKey, session.agentName, "Bot approval must remain scoped to its named conversation");
  assert.equal(approvedInput.customAgentId, agentId);
  assert.equal(approvedInput.customAgentVersion, 2);
  assert.equal(approvedInput.task, `${instructions(2)}\n\n---\n\n${task}`);
  assert.equal(approvedInput.route.modelId, model);
  assert.equal(approvedInput.route.harness, "opencode");
  assert.equal(approvedInput.route.connectionId, null);
  const beforeApproval = await json(`/api/runs?session=${sessionId}`);
  assert(!beforeApproval.runs.some((run) => run.runId === runId), "No execution receipt may be created before human approval");
  report.frozenApproval = { ...snapshot(approvedInput), threadKey: approvedInput.threadKey };
  passed("Composer retry queues the exact bot/session/configuration with the same command ID and freezes version 2 before approval");

  stage = "freeze";
  await editProfile(3);
  const stillPending = await pending();
  assert.deepEqual(snapshot(stillPending), snapshot(approvedInput));
  passed("Editing the profile to version 3 does not rewrite the pending approved inputs");

  stage = "approve";
  await page.getByRole("navigation", { name: "Main", exact: true }).locator('button[aria-haspopup="true"]').click();
  await page.getByRole("menuitem", { name: /^Approvals(?:\s+\d+)?$/ }).click();
  const approvalCard = page.locator("div").filter({ has: page.getByRole("button", { name: "Approve", exact: true }) }).filter({ hasText: task }).last();
  await approvalCard.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await approvalCard.getByText("Bot profile v2", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "pending-approval.png"), fullPage: true });
  const approvalResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/approvals" && response.request().method() === "POST");
  await approvalCard.getByRole("button", { name: "Approve", exact: true }).click();
  const decided = await approvalResponse;
  assert.equal(decided.status(), 200, await decided.text());
  passed("A browser click grants the human approval; no automatic profile policy bypass");

  stage = "execute";
  const completed = await waitFor("synthetic profile run", async () => {
    const body = await json(`/api/runs/${encodeURIComponent(runId)}?session=${sessionId}`);
    const run = body.run ?? body;
    if (["error", "cancelled", "unknown"].includes(run.status)) throw new Error(`Run failed: ${run.status} ${run.error ?? ""}`);
    return run.status === "completed" ? run : null;
  }, { timeoutMs: 120_000, intervalMs: 500 });
  assert.deepEqual(snapshot(completed), snapshot(approvedInput));
  assert.match(completed.summary, /verify-shiba stand-in/);
  assert.equal(completed.approval.approvalId, approvalId);
  report.completedRun = { ...snapshot(completed), runId, status: completed.status, summary: completed.summary };
  passed("Synthetic execution completes with the frozen profile version 2 and route despite the live profile being version 3");
  const panelResponse = (action) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === `/api/v1/threads/${encodeURIComponent(runId)}/pr/${action}`;
  });
  const reviewReadPromise = panelResponse("review");
  await page.goto(new URL("/app/", base).href);
  await page.getByRole("option").filter({ hasText: name }).first().click();
  await page.getByTestId("run-agent-version").filter({ hasText: "Bot profile v2" }).first().waitFor();
  const reviewRead = await reviewReadPromise;
  assert.equal(new URL(reviewRead.url()).searchParams.get("session"), sessionId);
  assert.equal(reviewRead.status(), 200, "Named conversation review must resolve its own run");
  await page.getByTestId("review-findings").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("pr-card").count(), 0, "A run that did not request a pull request must not mount a PR status panel");
  assert(!/Review:\s*Run(?:\s|_)*not(?:\s|_)*found/i.test(await page.locator("body").innerText()), "A completed named-session run must not show a false review error");
  report.completedPanels = {
    review: { session: sessionId, status: reviewRead.status() },
    pullRequest: { requested: false, visible: false },
  };
  await page.screenshot({ path: resolve(output, "completed-profile-run.png"), fullPage: true });
  passed("Conversation history shows the frozen bot version and scopes review/PR reads without false missing-run errors");

  stage = "archive";
  await directory();
  const archiveResponse = page.waitForResponse((response) => response.url().endsWith(`/api/custom-agents/${agentId}/archive`) && response.request().method() === "POST");
  await page.getByRole("button", { name: `Archive bot ${name}`, exact: true }).click();
  assert.equal((await archiveResponse).status(), 200);
  await page.getByRole("button", { name: `Launch bot ${name}`, exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Archived bots", exact: true }).click();
  await page.getByRole("button", { name: `Restore bot ${name}`, exact: true }).waitFor();
  assert.equal(await card().getByRole("button", { name: `Launch bot ${name}`, exact: true }).count(), 0);
  const forbiddenSession = await page.request.post(new URL("/api/sessions", base).href, { data: { name: "must not exist", metadata: { customAgentId: agentId } } });
  assert([404, 409].includes(forbiddenSession.status()), `Archived profile admitted a new thread: ${forbiddenSession.status()}`);
  const forbiddenRun = await page.request.post(new URL(`/api/runs?session=${sessionId}`, base).href, { data: { task: "must not execute", customAgentId: agentId } });
  assert([404, 409].includes(forbiddenRun.status()), `Archived profile admitted a new run: ${forbiddenRun.status()}`);
  const oldThread = await json(`/api/sessions/${sessionId}`);
  assert.equal(oldThread.session.metadata.customAgentId, agentId);
  await card().getByRole("list", { name: `${name} threads`, exact: true }).getByRole("button").filter({ hasText: name }).first().click();
  await page.getByLabel("Task composer").waitFor();
  passed("Archive blocks new threads and runs while preserving access to the existing conversation");

  stage = "restore";
  await directory(true);
  const restoreResponse = page.waitForResponse((response) => response.url().endsWith(`/api/custom-agents/${agentId}/restore`) && response.request().method() === "POST");
  await page.getByRole("button", { name: `Restore bot ${name}`, exact: true }).click();
  assert.equal((await restoreResponse).status(), 200);
  await page.getByRole("button", { name: "Active bots", exact: true }).click();
  await page.getByRole("button", { name: `Launch bot ${name}`, exact: true }).waitFor();
  const restored = await json(`/api/custom-agents/${agentId}`);
  assert.equal(restored.agent.version, 3);
  assert.equal(restored.agent.config.instructions, instructions(3));
  const history = await json(`/api/runs/${encodeURIComponent(runId)}?session=${sessionId}`);
  assert.deepEqual(snapshot(history.run ?? history), snapshot(approvedInput));
  await page.screenshot({ path: resolve(output, "restored-agent-history.png"), fullPage: true });
  passed("Restore retains the latest editable profile and the older run's frozen provenance and conversation history");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = `${stage}: ${String(error)}`;
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.fixture = { agentId, sessionId, approvalId, runId };
  report.cleanup = [];
  // Only IDs returned by this invocation are eligible for cleanup.
  if (approvalId) {
    const record = await pending().catch(() => null);
    if (record) {
      const rejected = await page.request.post(new URL("/api/approvals", base).href, { data: { approvalId, threadKey: record.threadKey, approved: false } });
      report.cleanup.push({ kind: "pending-approval", status: rejected.status() });
    }
  }
  for (const [kind, id] of [["sessions", sessionId], ["custom-agents", agentId]]) {
    if (!id) continue;
    try {
      const response = await page.request.delete(new URL(`/api/${kind}/${encodeURIComponent(id)}`, base).href);
      report.cleanup.push({ kind, status: response.status() });
      assert(response.ok(), `Own fixture cleanup failed: ${kind} ${response.status()}`);
    } catch (error) {
      report.cleanupError = String(error);
      report.status = "FAIL";
      process.exitCode = 1;
    }
  }
  writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2));
  await context.tracing.stop({ path: resolve(output, "trace.zip") });
  await target.close();
  console.log(JSON.stringify(report, null, 2));
}
