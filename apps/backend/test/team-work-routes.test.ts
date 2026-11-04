import type { DatabaseSync } from "node:sqlite";
import { runInputHash, type DelegatedRun, type PendingApproval } from "@shiba/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindCollaborationContextApproval, freezeCollaborationContext } from "../src/collaboration-context.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import {
  addCollaborationMember, createCollaborationRoom, createRootCollaborationHandoff, humanActorId,
  linkCollaborationHandoffRun, pinCollaborationHandoffExecutor, type CollaborationHandoffRow,
} from "../src/collaboration-store.js";
import { INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from "../src/edge-identity.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import type { Env } from "../src/env.js";
import { handleTeamWork, TEAM_WORK_LIMITS, type TeamWorkItemDto } from "../src/team-work-routes.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { buildSessionAgentName } from "../src/web-sessions.js";

const state = vi.hoisted(() => ({
  authorized: true, userId: "member@example.test", names: [] as string[], requests: [] as Request[],
  runs: new Map<string, DelegatedRun>(), duringRead: undefined as (() => Promise<void> | void) | undefined,
  approvals: [] as PendingApproval[],
  activeReads: 0, maxReads: 0,
}));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => state.authorized,
  resolveUserId: async () => state.userId,
}));
vi.mock("agents/routing", () => ({ getAgentByName: async (_binding: unknown, name: string) => {
  state.names.push(name);
  return { fetch: async (request: Request) => {
    state.requests.push(request);
    state.maxReads = Math.max(state.maxReads, ++state.activeReads);
    try {
      await state.duringRead?.();
      if (new URL(request.url).pathname === "/api/approvals") return Response.json({ approvals: state.approvals });
      const runId = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
      const run = state.runs.get(`${name}|${runId}`);
      return run ? Response.json({ run }) : Response.json({}, { status: 404 });
    } finally { state.activeReads--; }
  } };
} }));

const OWNER = "owner@example.test", MEMBER = "member@example.test", OTHER = "other@example.test";
const ROOM = `room_${"a".repeat(24)}`;
const databases: DatabaseSync[] = [];
beforeEach(() => {
  state.authorized = true; state.userId = MEMBER; state.names.length = 0; state.requests.length = 0;
  state.runs.clear(); state.approvals = []; state.duringRead = undefined; state.activeReads = 0; state.maxReads = 0;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

interface TeamWorkResponse {
  workspaceId: string;
  currentActorId: string;
  tasks: TeamWorkItemDto[];
  truncated: boolean;
}
async function workBody(response: Response | null): Promise<TeamWorkResponse> {
  if (!response) throw new Error("Expected the team Work route to handle this request.");
  expect(response.status).toBe(200);
  return await response.json() as TeamWorkResponse;
}

async function fixture() {
  const { database, sqlite } = customAgentD1(); databases.push(sqlite);
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {}, INTERNAL_SIGNING_KEY: "fixture-worker-only-work-key" } as unknown as Env;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Product" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, MEMBER, invite.token, 3);
  const scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OWNER };
  const profile = await createCustomAgent(env, `team:${workspace.workspaceId}`, "writer", { name: "Writer", instructions: "Prepare reviewed work.", harness: "opencode" });
  const executors = new Map<string, string>();
  await createCollaborationRoom(env, scope, { roomId: ROOM, title: "Release room", visibility: "shared", createdAt: 4 });
  await addCollaborationMember(env, scope, ROOM, { userId: MEMBER, actorId: humanActorId(MEMBER), kind: "human", displayName: "Morgan", createdAt: 5 });
  await addCollaborationMember(env, scope, ROOM, { userId: OWNER, actorId: `agent:${profile.id}`, kind: "agent", displayName: "Writer", profileVersion: 1, createdAt: 5 });
  async function handoff(id = "handoff-task", kind: "human" | "agent" = "agent", selectedSource = false) {
    const approvalId = `approval-${id}`, runId = `agent-tool:${approvalId}`;
    const value: CollaborationHandoffRow = { ...scope, handoffId: id, roomId: ROOM, taskId: `Task ${id}`, senderUserId: OWNER,
      senderActorId: humanActorId(OWNER), recipientUserId: kind === "human" ? MEMBER : OWNER,
      recipientActorId: kind === "human" ? humanActorId(MEMBER) : `agent:${profile.id}`, parentHandoffId: null, rootHandoffId: id,
      depth: 0, ancestorHandoffIds: [], remainingBudget: 0, grantedCapabilities: ["room.read"],
      profileVersion: kind === "human" ? null : 1, status: "active", createdAt: 6, cancelledAt: null };
    expect(await createRootCollaborationHandoff(env, scope, value)).not.toBeNull();
    let task = "Approved shared task";
    let note: Awaited<ReturnType<typeof createCollaborationMemory>> | undefined;
    if (selectedSource) {
      note = await createCollaborationMemory(env, scope, ROOM, { id: `ctx_${id}`, title: "Release", content: "Selected room note." }, 7);
      task = (await freezeCollaborationContext(env, scope, ROOM, id, task, [], [{ id: note.id, version: 1, sha256: note.sha256 }])).task;
      await bindCollaborationContextApproval(env, id, approvalId, task);
    }
    const executorName = buildSessionAgentName(OWNER, crypto.randomUUID());
    const run: DelegatedRun = { runId, sandboxId: "PRIVATE-SANDBOX", repoUrl: "https://github.com/example/private", task, orgId: `team:${workspace.workspaceId}`,
      baseBranch: "main", publishPullRequest: false, status: "running", generation: 1, createdAt: 7, updatedAt: 8,
      customAgentId: profile.id, customAgentVersion: 1, collaborationHandoffId: id };
    run.approval = { approvalId, decidedBy: OWNER, decidedAt: 8, inputHash: runInputHash(run) };
    if (kind === "agent") {
      expect(await pinCollaborationHandoffExecutor(env, scope, id, executorName)).toBe(true);
      expect(await linkCollaborationHandoffRun(env, scope, id, approvalId, runId)).toBe(true);
      state.runs.set(`${executorName}|${runId}`, run);
      executors.set(runId, executorName);
    }
    return { value, run, note, executorName };
  }
  const send = (headers: Record<string, string> = {}, method = "GET", suffix = "") => handleTeamWork(new Request(
    `https://dashboard.test/api/workspaces/${workspace.workspaceId}/work${suffix}`, {
      method, headers: { Origin: "https://dashboard.test", Cookie: "PRIVATE-COOKIE", "X-Agent-Principal": "spoof", ...headers },
    }), env);
  const pending = (run: DelegatedRun): PendingApproval => ({ ...run, approvalId: run.approval!.approvalId,
    threadKey: executors.get(run.runId)!, kind: "run", status: "pending", createdAt: Date.now(), orgId: `team:${workspace.workspaceId}` });
  return { env, sqlite, scope, workspace, profile, handoff, send, pending };
}

describe("authorized shared Work projection", () => {
  it("projects only explicit room handoffs, correct human/employee identities and bound run status", async () => {
    const f = await fixture();
    const h = await f.handoff(); await f.handoff("human-assignment", "human");
    const response = await f.send();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await workBody(response);
    expect(body).toMatchObject({ workspaceId: f.workspace.workspaceId, currentActorId: humanActorId(MEMBER), truncated: false });
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "handoff-task", status: "running", assigneeKind: "agent", assigneeActorId: `agent:${f.profile.id}`, assigneeName: "Writer", viewerCanApprove: false }),
      expect.objectContaining({ id: "human-assignment", status: "queued", assigneeKind: "human", assigneeActorId: humanActorId(MEMBER), viewerCanApprove: false }),
    ]));
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|repoUrl|inputHash|summary|approved shared task/i);
    expect(state.names).toEqual([h.executorName]);
    expect(state.requests).toHaveLength(1);
    for (const request of state.requests) {
      expect(request.headers.has(INTERNAL_SIGNATURE_HEADER)).toBe(true);
      expect(request.headers.has("Cookie")).toBe(false); expect(request.headers.has("X-Agent-Principal")).toBe(false);
      expect((await verifyInternalRequest(request, f.env)).ok).toBe(true);
    }
  });

  it("rejects outsiders and users with no active room grant before executor reads", async () => {
    const f = await fixture(); await f.handoff();
    state.userId = OTHER;
    expect((await f.send())?.status).toBe(404);
    state.userId = MEMBER;
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(MEMBER);
    expect(await (await f.send())!.json()).toMatchObject({ tasks: [] });
    expect(state.names).toEqual([]);
  });

  it.each(["workspace", "room", "source", "handoff", "executor"])("fails closed when %s authority changes during an executor read", async (kind) => {
    const f = await fixture(); const h = await f.handoff("selected", "agent", true);
    state.duringRead = async () => {
      state.duringRead = undefined;
      if (kind === "workspace") f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE user_id=?").run(MEMBER);
      if (kind === "room") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(MEMBER);
      if (kind === "source") await revokeCollaborationMemory(f.env, f.scope, ROOM, { id: h.note!.id, version: 1 }, 10);
      if (kind === "handoff") f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(OTHER);
      if (kind === "executor") f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(buildSessionAgentName(OWNER, crypto.randomUUID()));
    };
    const response = await f.send();
    if (kind === "workspace") expect(response?.status).toBe(404);
    else {
      const body = await workBody(response);
      if (kind === "source") expect(body.tasks).toEqual([expect.objectContaining({ status: "blocked", resultAvailable: false })]);
      else expect(body.tasks).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("PRIVATE-SANDBOX");
      if (kind === "source") expect(body.tasks[0]?.runId).toBeUndefined();
    }
  });

  it.each(["task", "customAgentVersion", "collaborationHandoffId", "approval"])("never presents mismatched %s run evidence as completed", async (field) => {
    const f = await fixture(); const h = await f.handoff();
    h.run.status = "completed"; h.run.summary = "PRIVATE-RESULT";
    Object.assign(h.run, { [field]: field === "customAgentVersion" ? 2 : field === "approval" ? { ...h.run.approval, decidedBy: "automation:fixture" } : "other" });
    const body = await workBody(await f.send());
    expect(body.tasks).toEqual([expect.objectContaining({ status: "unknown", resultAvailable: false, viewerCanApprove: false })]);
    expect(body.tasks[0]?.runId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("PRIVATE-RESULT");
  });

  it("keeps unverified execution unknown and displays a verified completion without exposing its body", async () => {
    const f = await fixture(); const h = await f.handoff();
    state.runs.clear();
    expect((await workBody(await f.send())).tasks[0]).toMatchObject({ status: "unknown", resultAvailable: false });
    h.run.status = "completed"; h.run.summary = "PRIVATE-RESULT"; state.runs.set(`${h.executorName}|${h.run.runId}`, h.run);
    expect((await workBody(await f.send())).tasks[0]).toMatchObject({ status: "completed", resultAvailable: true, runId: h.run.runId });
    f.sqlite.prepare("UPDATE collaboration_handoffs SET status='cancelled',cancelled_at=20").run();
    state.requests.length = 0;
    expect((await workBody(await f.send())).tasks[0]).toMatchObject({ status: "cancelled", updatedAt: 20 });
    expect(state.requests).toHaveLength(0);
  });

  it("bounds executor concurrency and discloses capped room coverage", async () => {
    const f = await fixture();
    for (let index = 0; index < 9; index++) await f.handoff(`task-${index}`);
    state.duringRead = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 2)); };
    expect((await workBody(await f.send())).tasks).toHaveLength(9);
    expect(state.maxReads).toBeLessThanOrEqual(TEAM_WORK_LIMITS.concurrentReads);
    expect(state.maxReads).toBeGreaterThan(1);
    for (let index = 0; index < TEAM_WORK_LIMITS.rooms; index++) {
      await createCollaborationRoom(f.env, { ...f.scope, userId: MEMBER }, { roomId: `room_${index.toString(16).padStart(24, "0")}`, title: "Other authorized room", visibility: "shared", createdAt: index + 20 });
    }
    expect((await workBody(await f.send())).truncated).toBe(true);
  });

  it("requires a human session and same-origin bounded route, without allowing write methods", async () => {
    const f = await fixture();
    expect((await f.send({ Authorization: "Bearer fixture" }))?.status).toBe(401);
    state.authorized = false; expect((await f.send())?.status).toBe(401); state.authorized = true;
    expect((await f.send({}, "POST"))?.status).toBe(405);
    expect((await f.send({ Origin: "https://other.test" }))?.status).toBe(403);
    expect((await f.send({ "X-Shiba-Workspace": "default" }))?.status).toBe(404);
    expect((await f.send({}, "GET", "?owner=other"))?.status).toBe(404);
    expect(await handleTeamWork(new Request("https://dashboard.test/api/workspaces"), f.env)).toBeNull();
    expect(state.requests).toHaveLength(0);
  });

  it("projects Needs you only from the exact requester's current pending scoped approval without creating a run", async () => {
    const f = await fixture(), h = await f.handoff("pending", "agent", true);
    state.userId = OWNER;
    state.approvals = [f.pending(h.run)];
    state.runs.clear();
    const body = await workBody(await f.send());
    expect(body.tasks).toEqual([expect.objectContaining({ status: "needs-approval", approvalRequired: true, viewerCanApprove: true })]);
    expect(body.tasks[0]?.runId).toBeUndefined();
    expect(state.requests).toHaveLength(2);
    expect(state.requests.every((request) => request.method === "GET" && new URL(request.url).pathname === "/api/approvals")).toBe(true);
    expect(state.names.every((name) => name === h.executorName)).toBe(true);
    expect(state.approvals[0]?.status).toBe("pending");
    expect(JSON.stringify(body)).not.toContain("Selected room note");
  });

  it("does not expose a requester's approval permission to another member who can read the room", async () => {
    const f = await fixture(), h = await f.handoff("pending", "agent", true);
    state.approvals = [f.pending(h.run)]; state.runs.clear();
    const body = await workBody(await f.send());
    expect(body.tasks[0]).toMatchObject({ status: "unknown", viewerCanApprove: false });
    expect(body.tasks[0]?.approvalRequired).not.toBe(true);
    expect(state.requests.some((request) => new URL(request.url).pathname === "/api/approvals")).toBe(false);
  });

  it.each(["expiry", "profile", "hash", "source", "capability"])("never projects approval permission after %s proof changes", async (field) => {
    const f = await fixture(), h = await f.handoff("pending", "agent", true);
    state.userId = OWNER; state.approvals = [f.pending(h.run)]; state.runs.clear();
    if (field === "expiry") state.approvals[0]!.createdAt = 1;
    if (field === "profile") state.approvals[0]!.customAgentVersion = 2;
    if (field === "hash") state.approvals[0]!.task = "Changed task outside frozen context";
    if (field === "source") await revokeCollaborationMemory(f.env, f.scope, ROOM, { id: h.note!.id, version: 1 }, 10);
    if (field === "capability") f.sqlite.prepare("UPDATE collaboration_memberships SET capabilities_json=? WHERE actor_id=?").run(JSON.stringify(["room.read"]), humanActorId(OWNER));
    const body = await workBody(await f.send());
    expect(body.tasks[0]?.viewerCanApprove).toBe(false);
    expect(body.tasks[0]?.approvalRequired).not.toBe(true);
    expect(state.requests.every((request) => request.method === "GET")).toBe(true);
    expect(state.approvals[0]?.status).toBe("pending");
  });

  it("rechecks pending authority after other asynchronous reads before returning Needs you", async () => {
    const f = await fixture(), h = await f.handoff("pending", "agent", true);
    state.userId = OWNER; state.approvals = [f.pending(h.run)]; state.runs.clear();
    let approvalReads = 0;
    state.duringRead = () => {
      if (new URL(state.requests.at(-1)!.url).pathname === "/api/approvals" && ++approvalReads === 2) state.approvals[0]!.createdAt = 1;
    };
    const body = await workBody(await f.send());
    expect(approvalReads).toBe(2);
    expect(body.tasks[0]).toMatchObject({ status: "unknown", approvalRequired: false, viewerCanApprove: false });
    expect(state.approvals[0]?.status).toBe("pending");
    expect(state.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each([OWNER, buildSessionAgentName(OTHER, "11111111-1111-4111-8111-111111111111")])("never reads a base or other-owner pin %s for team Work", async (executor) => {
    const f = await fixture(); await f.handoff();
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(executor);
    const body = await workBody(await f.send());
    expect(body.tasks[0]).toMatchObject({ status: "unknown", viewerCanApprove: false });
    expect(body.tasks[0]?.runId).toBeUndefined();
    expect(state.names).toEqual([]);
    expect(state.requests).toEqual([]);
  });

  it("keeps the mixed-case human requester distinct from the exact isolated executor name", async () => {
    const f = await fixture(), h = await f.handoff("pending", "agent", true);
    const rawOwner = "Owner@Example.Test", executor = buildSessionAgentName(rawOwner, "11111111-1111-4111-8111-111111111111");
    f.sqlite.prepare("UPDATE collaboration_handoffs SET executor_agent_name=?").run(executor);
    state.userId = rawOwner;
    state.approvals = [{ ...f.pending(h.run), threadKey: executor }]; state.runs.clear();
    const body = await workBody(await f.send());
    expect(body.currentActorId).toBe(humanActorId(OWNER));
    expect(body.tasks[0]).toMatchObject({ status: "needs-approval", approvalRequired: true, viewerCanApprove: true });
    expect(state.names).toEqual([executor, executor]);
    expect(state.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
