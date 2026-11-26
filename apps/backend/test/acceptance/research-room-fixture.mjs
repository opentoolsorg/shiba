import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startWorkerFixture } from "./worker-fixture.mjs";

const ownerEmail = "native-owner@example.test";
const reviewerEmail = "research-reviewer@example.test";
const question = "Compare Linear and Jira for a five-person product team. Use only the approved sources and flag missing or conflicting evidence.";
const sources = [
  { title: "S1: Linear pricing", url: "https://linear.app/pricing", excerpt: "Unlimited members; 2 teams; 250 issues; Basic: $10 per user/month, billed yearly; Free includes issues, projects, cycles and initiatives." },
  { title: "S2: Atlassian Jira pricing", url: "https://www.atlassian.com/software/jira/pricing", excerpt: "Free plan lets you try Jira for up to 10 users with 2GB of storage. Standard offer metadata: USD $8.48 per user per month for 300 seats." },
  { title: "S4: Atlassian sprint documentation", url: "https://support.atlassian.com/jira-software-cloud/docs/what-is-a-sprint/", excerpt: "Only Scrum teams can use sprints." },
  { title: "S5: Software Lifecycle Jira review", url: "https://www.software-lifecycle.com/sites/jira", excerpt: "Standard $9.70 and Premium $19.60 per user a month for the first 100 users on monthly billing" },
];
const captureDate = "2026-11-25";
const citation = (index) => `[${sources[index].title}](${sources[index].url}) (${captureDate})`;
const evidence = [
  "# Synthetic fixture: evidence handoff",
  "",
  ...sources.map((source, index) => `- ${citation(index)}: ${source.excerpt}`),
].join("\n");
const brief = (revision) => [
  `# Synthetic fixture: Linear vs Jira brief — revision ${revision}`,
  "",
  "Prewritten fixture; no model generated this brief.",
  "",
  "| Claim | Source | Evidence status |",
  "| --- | --- | --- |",
  `| Linear Free covers unlimited members, 2 teams and 250 issues. | ${citation(0)} | Supported |`,
  `| Linear Free includes cycles; Linear Basic is $10 per user/month, billed yearly. | ${citation(0)} | Supported |`,
  `| Jira Free covers 10 users and 2 GB of storage. | ${citation(1)} | Supported |`,
  `| The sprint documentation does not confirm Jira Free eligibility. | ${citation(2)} | Missing: tier not stated |`,
  `| Jira Standard figures differ: $8.48 at 300 seats and $9.70 for the first 100. | ${citation(1)}; ${citation(3)} | Unreconciled: different quantities |`,
  "",
  ...(revision === 2 ? ["Recommendation: trial both free tiers; get a five-seat Jira quote before using price to decide."] : []),
].join("\n");

async function waitFor(label, read) {
  const deadline = Date.now() + 20_000;
  do {
    const value = await read();
    if (value) return value;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

async function seedVerifiedInvitee(persistDir, reviewer, invitation) {
  const authRequire = createRequire(new URL("../../../../packages/auth/package.json", import.meta.url));
  const { hashPassword } = await import(pathToFileURL(authRequire.resolve("better-auth/crypto")).href);
  const hash = await hashPassword(reviewer.password);
  // The local fixture has no email sender. Seed only this newly invited, synthetic
  // account in the fixture-owned D1. Better Auth still issues both real sessions.
  const d1 = path.join(persistDir, "v3", "d1", "miniflare-D1DatabaseObject");
  const matches = (await readdir(d1)).filter((name) => name.endsWith(".sqlite")).filter((name) => {
    const candidate = new DatabaseSync(path.join(d1, name), { readOnly: true });
    try {
      return candidate.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='team_workspace_invitations'").get() &&
        candidate.prepare("SELECT 1 FROM team_workspace_invitations WHERE invitation_id=? AND workspace_id=? AND email=? AND status='pending'")
          .get(invitation.invitationId, invitation.workspaceId, reviewer.email);
    } finally { candidate.close(); }
  });
  assert.equal(matches.length, 1, "Expected the pending invitation in one fixture database");
  const db = new DatabaseSync(path.join(d1, matches[0]));
  const id = randomUUID(), now = Date.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)`)
      .run(id, reviewer.name, reviewer.email, now, now);
    db.prepare(`INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,?,?)`)
      .run(randomUUID(), id, id, hash, now, now);
    db.prepare(`INSERT INTO shiba_auth_account_policy (account_id,email,kind,invitation_id,workspace_id) VALUES (?,?,'invited',?,?)`)
      .run(id, reviewer.email, invitation.invitationId, invitation.workspaceId);
    db.exec("COMMIT");
  } finally { db.close(); }
}

export async function startResearchRoomFixture(options = {}) {
  const worker = await startWorkerFixture({ ...options, localRuntime: true });
  const identity = (name, email) => ({ name, email, password: randomBytes(24).toString("base64url") });
  const owner = identity("Fixture Owner", ownerEmail);
  const reviewer = identity("Fixture Reviewer", reviewerEmail);
  const sessions = new Map();
  let workspaceId;
  const request = async (actor, route, { body, method = body === undefined ? "GET" : "POST", status = 200, bearer, text = false } = {}) => {
    const url = new URL(route, worker.origin);
    assert.equal(url.origin, worker.origin, "Fixture requests must stay on the isolated Worker");
    const response = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { origin: worker.origin, ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : sessions.has(actor) ? { cookie: sessions.get(actor) } : {}),
        ...(workspaceId && (route.startsWith("/api/collaboration/") || route === "/api/custom-agents")
          ? { "X-Shiba-Workspace": workspaceId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, `${method} ${route} expected HTTP ${status} (received ${response.status})`);
    if (route.startsWith("/api/auth/")) {
      const cookies = response.headers.getSetCookie();
      if (cookies.length) sessions.set(actor, cookies.map((cookie) => cookie.split(";")[0]).join("; "));
    }
    return text ? response.text() : response.json();
  };
  const post = (actor, route, body, status = 200) => request(actor, route, { body, status });
  try {
    await post(owner, "/api/auth/sign-up/email", owner);
    const { workspace } = await post(owner, "/api/workspaces", { name: "Research fixture workspace" }, 201);
    workspaceId = workspace.workspaceId;
    const { invitation, token } = await post(owner, `/api/workspaces/${workspaceId}/invitations`, { email: reviewer.email, role: "member" }, 201);
    await seedVerifiedInvitee(worker.persistDir, reviewer, invitation);
    await post(reviewer, "/api/auth/sign-in/email", { email: reviewer.email, password: reviewer.password });
    await post(reviewer, "/api/workspaces/invitations/accept", { token });
    const { room } = await post(owner, "/api/collaboration/rooms", { title: "Research brief fixture", visibility: "shared" }, 201);
    const roomPath = `/api/collaboration/rooms/${room.roomId}`;
    const { member: reviewerMember } = await post(owner, `${roomPath}/members`, { userId: reviewer.email }, 201);
    await post(owner, `${roomPath}/messages`, { body: question }, 201);
    const memoryRefs = [];
    for (const source of sources) {
      const { memory } = await post(owner, `${roomPath}/memory`, {
        id: `ctx_${randomBytes(12).toString("hex")}`, title: source.title,
        content: `${source.url}\nCaptured ${captureDate}: ${source.excerpt}`,
      }, 201);
      memoryRefs.push({ id: memory.id, version: memory.version, sha256: memory.sha256 });
    }

    async function addEmployee(slug, name) {
      const { agent } = await post(owner, "/api/custom-agents", { slug, config: {
        name, instructions: "Use only approved room sources. Never publish.", harness: "opencode",
      } }, 201);
      const { member } = await post(owner, `${roomPath}/agents`, { profileId: agent.id, profileVersion: agent.version }, 201);
      return member.actorId;
    }
    const gatherer = await addEmployee("fixture-gatherer", "Fixture Evidence Researcher");
    const drafter = await addEmployee("fixture-drafter", "Fixture Brief Writer");
    const pairing = await post(owner, "/api/computers/pairing-token", {});
    const machine = { hostname: "research-fixture", platform: "linux-x64", daemonVersion: "fixture", harnesses: ["opencode"] };
    const paired = await post(owner, "/api/local/pair", { ...machine, pairingToken: pairing.token });
    const local = (route, body) => request(null, `/api/local/${route}`, { body, bearer: paired.adapterToken });
    const claim = () => local("claim", { operator: "research-fixture" });
    async function produce({ handoffId, recipientActorId, parent, task, file, content }) {
      // A person may leave the first revision open longer than the adapter's heartbeat TTL.
      await local("heartbeat", { ...machine, machineId: paired.machineId });
      const { handoff } = await post(owner, `${roomPath}/handoffs`, {
        handoffId, taskId: "research-brief", recipientActorId, task, memoryRefs,
        ...(parent ? { parentHandoffId: parent.handoff.handoffId, contextMessageIds: [parent.reply.messageId] } : {}),
        executionTarget: { kind: "artifact-workspace", workspaceName: "Private research outputs", expectedDeliverables: [file] },
        runtime: "local", targetMachineId: paired.machineId,
      }, 201);
      const approvalPath = `${roomPath}/handoffs/${handoffId}/approval`;
      const { inputHash, approval } = await request(owner, approvalPath);
      assert.equal(approval.status, "pending");
      assert.equal(approval.publishPullRequest, false);
      assert.equal((await claim()).envelope, null, "A handoff cannot run before approval");
      assert.equal((await post(owner, approvalPath, { reviewed: true, approved: true, expectedInputHash: inputHash })).result, "approved");
      const { envelope, claimToken } = await waitFor("approved synthetic adapter job", async () => {
        const job = await claim();
        return job.envelope ? job : null;
      });
      assert.deepEqual(envelope.expectedDeliverables, [file]);
      await local("result", { sandboxId: envelope.sandboxId, claimToken, result: {
        status: "completed", exitCode: 0, summary: `Synthetic fixture: ${file} (no model; room only).`,
        stdoutTail: "", stderrTail: "", changedFiles: [file], diff: "",
        files: [{ path: file, encoding: "utf8", content }],
      } });
      const reply = await waitFor("completed handoff shared in the room", async () => {
        const detail = await request(owner, roomPath);
        const runStatus = detail.handoffs.find((entry) => entry.handoffId === handoffId)?.execution?.runStatus;
        assert(!["error", "unknown", "aborted"].includes(runStatus), `${handoffId} did not complete`);
        return detail.messages.find((message) => message.sourceHandoffId === handoffId && message.sourceArtifactRefs?.length === 1);
      });
      assert.equal(reply.senderActorId, recipientActorId);
      const artifactPath = `${roomPath}/handoffs/${handoffId}/artifacts/0`;
      assert.equal(await request(reviewer, artifactPath, { text: true }), content);
      return { handoff, reply, artifactPath, file };
    }
    const research = await produce({ handoffId: "fixture-evidence", recipientActorId: gatherer,
      task: question, file: "reports/evidence.md", content: evidence });
    const first = await produce({ handoffId: "fixture-brief-v1", recipientActorId: drafter, parent: research,
      task: "Draft a room-only brief using the researcher’s handoff and approved notes.",
      file: "reports/brief-v1.md", content: brief(1) });
    const revise = async () => {
      const { review } = await request(reviewer, `${first.artifactPath}/review`);
      assert.equal(review.status, "changes_requested", "The reviewer must request changes first");
      return produce({ handoffId: "fixture-brief-v2", recipientActorId: drafter, parent: first,
        task: `Revise the room-only brief using the reviewer’s note: ${review.note}`,
        file: "reports/brief-v2.md", content: brief(2) });
    };
    const roomUrl = `${worker.origin}/threads/?${new URLSearchParams({ workspace: workspaceId, room: room.roomId })}`;
    return { ...worker, owner, reviewer, workspaceId, roomUrl, roomPath, reviewerMember, research, first, revise, request, claim };
  } catch (error) {
    await worker.stop();
    throw error;
  }
}
