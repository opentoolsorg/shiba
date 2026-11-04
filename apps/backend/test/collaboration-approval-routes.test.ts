import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInputHash, type PendingApproval } from "@shiba/shared";
import { handleCollaborationApproval } from "../src/collaboration-approval-routes.js";
import { bindCollaborationContextApproval, freezeCollaborationContext } from "../src/collaboration-context.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import { addCollaborationMember, createCollaborationRoom, createRootCollaborationHandoff, humanActorId,
  linkCollaborationHandoffRun, pinCollaborationHandoffExecutor, type CollaborationHandoffRow } from "../src/collaboration-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from "../src/edge-identity.js";
import type { Env } from "../src/env.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { buildSessionAgentName } from "../src/web-sessions.js";

const state = vi.hoisted(() => ({ approval: null as PendingApproval | null, names: [] as string[], calls: [] as Request[],
  decisions: 0, duringRead: undefined as (() => void | Promise<void>) | undefined, duringWrite: undefined as (() => void | Promise<void>) | undefined }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async (request: Request) => request.headers.get("Cookie") === "fixture-human",
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-User"),
}));
vi.mock("agents/routing", () => ({ getAgentByName: async (_namespace: unknown, name: string) => {
  state.names.push(name);
  return { fetch: async (request: Request) => {
    state.calls.push(request);
    if (request.method === "GET") {
      await state.duringRead?.();
      return Response.json({ approvals: [state.approval, { approvalId: "private-other", task: "Private unrelated approval", threadKey: "other@example.test" }] });
    }
    await state.duringWrite?.();
    const body = await request.clone().json() as { expectedInputHash: string; approved: boolean };
    const approval = state.approval!;
    if (approval.status !== "pending" || body.expectedInputHash !== runInputHash({ ...approval, baseBranch: approval.baseBranch ?? "main", publishPullRequest: approval.publishPullRequest ?? false })) return Response.json({ result: "unknown" });
    state.decisions++;
    approval.status = body.approved ? "approved" : "rejected";
    return Response.json({ result: approval.status });
  } };
} }));
const OWNER = "owner@example.test", MEMBER = "member@example.test", ROOM = `room_${"a".repeat(24)}`, HANDOFF = "handoff-approved", APPROVAL = "approval-exact";
const SESSION = "11111111-1111-4111-8111-111111111111", EXECUTOR = buildSessionAgentName(OWNER, SESSION);
beforeEach(() => { state.approval = null; state.names.length = 0; state.calls.length = 0; state.decisions = 0; state.duringRead = undefined; state.duringWrite = undefined; });
async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {}, INTERNAL_SIGNING_KEY: "fixture-internal-worker-signing-key" } as unknown as Env;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Team" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" });
  await acceptTeamWorkspaceInvitation(env, MEMBER, invitation.token);
  const scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OWNER };
  const orgId = `team:${workspace.workspaceId}`;
  const profile = await createCustomAgent(env, orgId, "reporter", { name: "Reporter", instructions: "Prepare a reviewed report.", harness: "opencode" });
  await createCollaborationRoom(env, scope, { roomId: ROOM, title: "Reports", visibility: "shared", createdAt: 1 });
  await addCollaborationMember(env, scope, ROOM, { userId: MEMBER, actorId: humanActorId(MEMBER), kind: "human", displayName: "Member", createdAt: 2 });
  await addCollaborationMember(env, scope, ROOM, { userId: OWNER, actorId: `agent:${profile.id}`, kind: "agent", displayName: "Reporter", profileVersion: 1, createdAt: 2 });
  const handoff: CollaborationHandoffRow = { ...scope, handoffId: HANDOFF, roomId: ROOM, taskId: "report",
    senderUserId: OWNER, senderActorId: humanActorId(OWNER), recipientUserId: OWNER, recipientActorId: `agent:${profile.id}`,
    parentHandoffId: null, rootHandoffId: HANDOFF, depth: 0, ancestorHandoffIds: [], remainingBudget: 0, grantedCapabilities: ["room.read"],
    profileVersion: 1, status: "active", createdAt: 3, cancelledAt: null };
  expect(await createRootCollaborationHandoff(env, scope, handoff)).not.toBeNull();
  const note = await createCollaborationMemory(env, scope, ROOM, { id: "ctx_report", title: "Deadline", content: "The report is due Tuesday." });
  const frozen = await freezeCollaborationContext(env, scope, ROOM, HANDOFF, "Prepare the report.", [], [{ id: note.id, version: 1, sha256: note.sha256 }]);
  await bindCollaborationContextApproval(env, HANDOFF, APPROVAL, frozen.task);
  await pinCollaborationHandoffExecutor(env, scope, HANDOFF, EXECUTOR);
  await linkCollaborationHandoffRun(env, scope, HANDOFF, APPROVAL, `agent-tool:${APPROVAL}`);
  state.approval = { approvalId: APPROVAL, threadKey: EXECUTOR, kind: "run", task: frozen.task, repoUrl: "https://github.com/example/repo",
    baseBranch: "main", publishPullRequest: false, runtime: "sandbox", status: "pending", createdAt: Date.now(),
    customAgentId: profile.id, customAgentVersion: 1, collaborationHandoffId: HANDOFF, orgId,
    expectedDeliverables: ["report.md"], envNames: ["REPORT_MODE"], envDigest: "d".repeat(64), envSealed: "fixture-encrypted-never-public" };
  const hash = () => runInputHash({ ...state.approval!, baseBranch: state.approval!.baseBranch ?? "main", publishPullRequest: state.approval!.publishPullRequest ?? false });
  const send = (method = "GET", body?: unknown, user = OWNER, headers: Record<string, string> = {}) => handleCollaborationApproval(new Request(`https://dashboard.test/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/approval`, {
    method, headers: { Cookie: "fixture-human", "X-Fixture-User": user, "X-Shiba-Workspace": workspace.workspaceId, origin: "https://dashboard.test", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }), env);
  return { env, sqlite, workspace, scope, note, profile, send, hash };
}

describe("requester-only collaboration run approval", () => {
  it("returns only the exact complete frozen card and omits sealed environment material", async () => {
    const f = await fixture(), response = (await f.send())!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { approval: PendingApproval; inputHash: string };
    expect(body.inputHash).toBe(f.hash()); expect(body.approval.task).toContain("The report is due Tuesday.");
    expect(body.approval.expectedDeliverables).toEqual(["report.md"]);
    expect(JSON.stringify(body)).not.toMatch(/fixture-encrypted|Private unrelated/);
    expect(state.names).toEqual([EXECUTOR]);
    expect(state.calls[0]!.headers.has(INTERNAL_SIGNATURE_HEADER)).toBe(true);
    expect((await verifyInternalRequest(state.calls[0]!, f.env)).ok).toBe(true);
    expect(state.calls[0]!.headers.has("Cookie")).toBe(false);
    expect(state.decisions).toBe(0);
  });
  it("preserves the pinned executor while presenting the canonical human identity", async () => {
    const f = await fixture();
    const rawOwner = "Owner@Example.test";
    const rawExecutor = buildSessionAgentName(rawOwner, SESSION);
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=? WHERE handoff_id=?").run(rawExecutor, HANDOFF);
    state.approval!.threadKey = rawExecutor;
    const response = (await f.send("GET", undefined, rawOwner))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requesterUserId: OWNER, approval: { threadKey: rawExecutor } });
    expect(state.names).toEqual([rawExecutor]);
    expect(state.decisions).toBe(0);
  });
  it("keeps the raw authenticated decider separate from the pinned executor spelling", async () => {
    const f = await fixture(), rawOwner = "Owner@Example.Test";
    const response = await f.send("POST", { expectedInputHash: f.hash(), reviewed: true, approved: true }, rawOwner);
    expect(response?.status).toBe(200);
    const decision = state.calls.find((request) => request.method === "POST");
    expect(await decision!.clone().json()).toMatchObject({ threadKey: EXECUTOR, decidedBy: rawOwner });
    expect(state.names).toEqual([EXECUTOR]);
  });
  it.each([true, false])("records the reviewed human decision %s once without global fanout", async (approved) => {
    const f = await fixture(); const expectedInputHash = f.hash();
    expect((await f.send("POST", { expectedInputHash, reviewed: true, approved }))?.status).toBe(200);
    expect(state.decisions).toBe(1);
    const forwarded = await state.calls.find((r) => r.method === "POST")!.clone().json();
    expect(forwarded).toMatchObject({ threadKey: EXECUTOR, approvalId: APPROVAL, expectedInputHash, decidedBy: OWNER, source: "dashboard", approved });
    expect(state.names.every((name) => name === EXECUTOR)).toBe(true);
    expect((await f.send("POST", { expectedInputHash, reviewed: true, approved }))?.status).toBe(409);
    expect(state.decisions).toBe(1);
  });
  it("rejects members other than the requester, outsiders, bearer identities and cross-site decisions before RPC", async () => {
    const f = await fixture();
    expect((await f.send("GET", undefined, MEMBER))?.status).toBe(404);
    expect((await f.send("GET", undefined, "outsider@example.test"))?.status).toBe(404);
    expect((await f.send("GET", undefined, OWNER, { Authorization: "Bearer fixture" }))?.status).toBe(401);
    expect((await f.send("POST", { expectedInputHash: f.hash(), reviewed: true, approved: true }, OWNER, { Origin: "https://evil.test" }))?.status).toBe(403);
    expect(state.names).toHaveLength(0); expect(state.decisions).toBe(0);
  });
  it.each(["kind", "orgId", "threadKey", "customAgentVersion", "collaborationHandoffId", "queuedBy", "expiry"])("rejects changed %s approval provenance", async (field) => {
    const f = await fixture();
    if (field === "expiry") state.approval!.createdAt = 1;
    else Object.assign(state.approval!, { [field]: field === "customAgentVersion" ? 2 : field === "kind" ? "pr_publish" : "other" });
    expect((await f.send())?.status).toBe(409); expect(state.decisions).toBe(0);
  });
  it.each(["source", "member", "capability", "workspace", "handoff", "profile"])("fails closed when %s changes during approval lookup", async (field) => {
    const f = await fixture();
    state.duringRead = async () => {
      if (field === "source") await revokeCollaborationMemory(f.env, f.scope, ROOM, { id: f.note.id, version: 1 });
      if (field === "member") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE actor_id=?").run(humanActorId(OWNER));
      if (field === "capability") f.sqlite.prepare("UPDATE collaboration_memberships SET capabilities_json='[\"room.read\",\"handoff.create\"]' WHERE actor_id=?").run(humanActorId(OWNER));
      if (field === "workspace") f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE user_id=?").run(OWNER);
      if (field === "handoff") f.sqlite.prepare("UPDATE collaboration_handoffs SET status='cancelled'").run();
      if (field === "profile") f.sqlite.prepare("UPDATE org_custom_agents SET archived_at=1 WHERE id=?").run(f.profile.id);
    };
    expect((await f.send("POST", { expectedInputHash: f.hash(), reviewed: true, approved: true }))?.status).toBe(409);
    expect(state.decisions).toBe(0);
  });
  it("requires complete explicit review and the current hash, with bounded request bodies", async () => {
    const f = await fixture();
    for (const body of [{ expectedInputHash: f.hash(), approved: true }, { expectedInputHash: f.hash(), reviewed: true, approved: true, decidedBy: MEMBER }, "x".repeat(4097)]) {
      expect((await f.send("POST", body))?.status).toBe(400);
    }
    expect((await f.send("POST", { expectedInputHash: "f".repeat(64), reviewed: true, approved: true }))?.status).toBe(409);
    expect(state.decisions).toBe(0);
  });

  it.each([OWNER, buildSessionAgentName("other@example.test", SESSION)])("rejects a team base or other-owner executor pin %s before RPC", async (executor) => {
    const f = await fixture();
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=? WHERE handoff_id=?").run(executor, HANDOFF);
    state.approval!.threadKey = executor;
    expect((await f.send())?.status).toBe(404);
    expect(state.names).toEqual([]);
    expect(state.decisions).toBe(0);
  });

  it("rejects a same-owner isolated executor swap while the approval read yields", async () => {
    const f = await fixture();
    const replacement = buildSessionAgentName(OWNER, "22222222-2222-4222-8222-222222222222");
    state.duringRead = () => { f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=? WHERE handoff_id=?").run(replacement, HANDOFF); };
    expect((await f.send("POST", { expectedInputHash: f.hash(), reviewed: true, approved: true }))?.status).toBe(409);
    expect(state.names).toEqual([EXECUTOR]);
    expect(state.calls.every((request) => request.method === "GET")).toBe(true);
    expect(state.decisions).toBe(0);
  });
});
