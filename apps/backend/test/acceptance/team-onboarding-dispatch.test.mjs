import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerFixture } from "./worker-fixture.mjs";

// Actual local Worker ingress, native auth, D1 and Durable Objects. The paired
// adapter returns clearly synthetic bytes; no model, provider or CLI is invoked.
test("saved team onboarding reaches one approved employee result through native Worker HTTP", { timeout: 180_000 }, async () => {
  const fixture = await startWorkerFixture({ localRuntime: true });
  let cookie = "", workspaceId = "";
  async function request(route, body, { bearer, team = true, status = 200 } = {}) {
    const response = await fetch(`${fixture.origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: fixture.origin,
        ...(cookie && !bearer ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(team && workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    if (route.startsWith("/api/auth/")) {
      const incoming = response.headers.getSetCookie();
      if (incoming.length) cookie = incoming.map((value) => value.split(";")[0]).join("; ");
    }
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`);
    return value;
  }
  async function until(label, operation) {
    const deadline = Date.now() + 15_000;
    do { const value = await operation(); if (value) return value; await delay(100); } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for ${label}`);
  }
  try {
    await request("/api/auth/sign-up/email", { name: "Fixture Owner", email: "native-owner@example.test", password: "fixture-team-password-only-2026!" });
    const pairing = await request("/api/computers/pairing-token", {}, { team: false });
    const paired = await request("/api/local/pair", { pairingToken: pairing.token, hostname: "team-fixture", platform: "linux-x64", daemonVersion: "fixture", harnesses: ["opencode"] }, { team: false });
    const local = (route, body) => request(`/api/local/${route}`, body, { bearer: paired.adapterToken, team: false });
    await local("heartbeat", { machineId: paired.machineId, hostname: "team-fixture", platform: "linux-x64", daemonVersion: "fixture", harnesses: ["opencode"] });
    const team = await request("/api/workspaces", { name: "Native team journey" }, { status: 201 });
    workspaceId = team.workspace.workspaceId;
    const { agent } = await request("/api/custom-agents", { slug: "team-fixture-writer", config: {
      name: "Team fixture writer", instructions: "Use only supplied facts. Return a clearly marked synthetic draft.", harness: "opencode",
    } }, { status: 201 });
    const initial = await request("/api/onboarding/progress");
    const draftTask = { goal: "Write the launch brief", audience: "Review team", acceptance: "Include supplied facts and flag missing evidence",
      contextAnswer: "Supplied fixture fact: launch is Friday.", employeeId: agent.id, employeeVersion: agent.version };
    const saved = await request("/api/onboarding/progress", { action: "save-draft", expectedRevision: initial.revision, draftTask });
    assert.equal(saved.draftTask.preparedAt, null, "Saving a team draft does not prepare or execute a private task");
    assert.deepEqual(saved.draftTask.sourceRefs, []);
    const query = new URLSearchParams({ draftTaskId: saved.draftTaskId, draftTaskVersion: String(saved.draftTask.version), expectedRevision: String(saved.revision) });
    // Bootstrap signup deliberately remains unverified. First prove the route
    // fails closed, then seed only this synthetic owner's verification state.
    // Email delivery/verification is NOT exercised by this local journey.
    await request(`/api/onboarding/progress/team-task?${query}`, undefined, { status: 403 });
    let verified = 0;
    for (const file of await readdir(fixture.persistDir, { recursive: true })) {
      if (!file.includes(`${path.sep}d1${path.sep}`) || !file.endsWith(".sqlite")) continue;
      const database = new DatabaseSync(path.join(fixture.persistDir, file));
      try {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get()) continue;
        verified += Number(database.prepare('UPDATE "user" SET emailVerified=1 WHERE email=? AND emailVerified=0').run("native-owner@example.test").changes);
      } finally { database.close(); }
    }
    assert.equal(verified, 1, "Only the synthetic native owner is seeded as verified");
    const snapshot = await request(`/api/onboarding/progress/team-task?${query}`);
    assert.equal(snapshot.workspaceId, workspaceId);
    assert.equal(snapshot.actorId, "native-owner@example.test");
    assert.deepEqual(snapshot.employee, { id: agent.id, version: agent.version });
    assert.match(snapshot.text, /Write the launch brief/);
    assert.match(snapshot.text, /launch is Friday/);
    assert(snapshot.expiresAt > Date.now());
    query.set("expectedRevision", String(saved.revision + 1));
    await request(`/api/onboarding/progress/team-task?${query}`, undefined, { status: 409 });
    assert.equal((await local("claim", { operator: "team-fixture" })).envelope, null, "Saving and reviewing a goal creates no executable work");

    const { room } = await request("/api/collaboration/rooms", { title: "Launch room", visibility: "shared" }, { status: 201 });
    const roomPath = `/api/collaboration/rooms/${room.roomId}`;
    const { member } = await request(`${roomPath}/agents`, { profileId: agent.id, profileVersion: agent.version }, { status: 201 });
    const handoffBody = { handoffId: "native-team-goal", taskId: "launch-brief", recipientActorId: member.actorId, task: snapshot.text,
      executionTarget: { kind: "artifact-workspace", workspaceName: "Launch outputs", expectedDeliverables: ["reports/launch.md"] },
      runtime: "local", targetMachineId: paired.machineId };
    const { handoff } = await request(`${roomPath}/handoffs`, handoffBody, { status: 201 });
    assert(handoff.approvalId, "Employee handoff creates a pending approval");
    const approvalPath = `${roomPath}/handoffs/${handoff.handoffId}/approval`;
    const review = await request(approvalPath);
    assert.equal(review.approval.status, "pending");
    assert.equal(review.approval.customAgentId, agent.id);
    assert.equal(review.approval.customAgentVersion, agent.version);
    assert.match(review.approval.task, /Write the launch brief/);
    assert.equal((await local("claim", { operator: "team-fixture" })).envelope, null, "No dispatch before exact human approval");
    await request(approvalPath, { reviewed: true, approved: true, expectedInputHash: "0".repeat(64) }, { status: 409 });
    assert.equal((await local("claim", { operator: "team-fixture" })).envelope, null, "Wrong-input approval does not dispatch");
    const decision = await request(approvalPath, { reviewed: true, approved: true, expectedInputHash: review.inputHash });
    assert.equal(decision.result, "approved");
    const claimed = await until("one approved local claim", async () => { const value = await local("claim", { operator: "team-fixture" }); return value.envelope ? value : null; });
    assert.equal(claimed.envelope.task, `${review.approval.task}\n\nWrite only these approved complete UTF-8 deliverables relative to your current working directory: reports/launch.md. Each file is limited to 16384 bytes, 65536 bytes total. Only these files will be privately exported; other files are not recoverable artifacts.`, "The adapter receives the frozen task plus only its approved artifact-output constraint");
    assert.equal(claimed.envelope.customAgentId, agent.id);
    assert.equal(claimed.envelope.customAgentVersion, agent.version);
    assert.deepEqual(claimed.envelope.expectedDeliverables, ["reports/launch.md"]);
    assert.equal((await local("claim", { operator: "team-fixture" })).envelope, null, "The approved job is claimed only once");
    const summary = "Synthetic team launch brief completed without a model or CLI.";
    await local("result", { sandboxId: claimed.envelope.sandboxId, claimToken: claimed.claimToken, result: {
      status: "completed", exitCode: 0, summary, stdoutTail: "fixture completed", stderrTail: "", changedFiles: ["reports/launch.md"],
      diff: "",
      files: [{ path: "reports/launch.md", encoding: "utf8", content: "Synthetic fixture: launch is Friday.\n" }],
    } });
    const completed = await until("persisted team result", async () => {
      const detail = await request(roomPath);
      const current = detail.handoffs.find((item) => item.handoffId === handoff.handoffId);
      assert(!["error", "unknown", "aborted"].includes(current?.execution?.runStatus), `Team dispatch failed: ${JSON.stringify(current)}`);
      return current?.execution?.runStatus === "completed" ? detail : null;
    });
    const reply = completed.messages.find((message) => message.sourceHandoffId === handoff.handoffId);
    assert(reply, "Completed employee output becomes a durable room reply");
    assert.equal(reply.senderKind, "agent");
    assert.equal(reply.sourceRunId, handoff.runId);
    assert.match(reply.body, /Synthetic team launch brief/);
    assert.equal((await request(roomPath)).messages.filter((message) => message.sourceHandoffId === handoff.handoffId).length, 1, "Reload does not duplicate the employee reply");
    assert.equal((await local("claim", { operator: "team-fixture" })).envelope, null, "Reading completed team work never redispatches it");
    assert.equal((await request("/api/onboarding/progress")).revision, saved.revision, "Execution does not falsely advance setup activation evidence");
  } catch (error) {
    console.error(fixture.logs.slice(-20).join("\n"));
    throw error;
  } finally { await fixture.stop(); }
});
