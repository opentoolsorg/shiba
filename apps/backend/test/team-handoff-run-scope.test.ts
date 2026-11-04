import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  addCollaborationMember, COLLAB_TENANT_ID, createCollaborationRoom, createRootCollaborationHandoff,
  humanActorId, pinCollaborationHandoffExecutor,
} from "../src/collaboration-store.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { createCollaborationMemory, revokeCollaborationMemory } from "../src/collaboration-memory.js";
import { freezeCollaborationContext } from "../src/collaboration-context.js";
import { resolveTeamHandoffRunScope, teamHandoffWorkspaceId } from "../src/collaboration-run-scope.js";
import { queueCollaborationRun } from "../src/runs-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ user: "member@example.test", restricted: false }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true, resolveUserId: async () => auth.user,
}));
vi.mock("agents/routing", () => ({ getAgentByName: async (namespace: { get(name: string): unknown }, name: string) => namespace.get(name) }));
vi.mock("../src/team-member-auth.js", () => ({ isRestrictedTeamMember: async () => auth.restricted }));

const owner = "owner@example.test", member = "member@example.test";
beforeEach(() => { auth.user = member; auth.restricted = false; });
async function fixture(withNote = false) {
  const db = customAgentD1();
  const forwarded: Array<{ owner: string; body: Record<string, unknown> }> = [];
  const env = { AGENT_AUDIT: db.database, BETTER_AUTH_SECRET: "fixture-only", CodingOrchestrator: { get: (name: string) => ({ fetch: async (request: Request) => {
    const body = await request.json() as Record<string, unknown>;
    forwarded.push({ owner: name, body });
    return Response.json({ ok: true, approvalId: "approval-team", task: body.task });
  } }) } } as unknown as Env;
  const workspace = await createTeamWorkspace(env, owner, { name: "Engineering" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, owner, { email: member, role: "member" });
  await acceptTeamWorkspaceInvitation(env, member, invitation.token);
  const ownerScope = { tenantId: COLLAB_TENANT_ID, workspaceId: workspace.workspaceId, userId: owner };
  const scope = { ...ownerScope, userId: member };
  const roomId = "room_111111111111111111111111";
  await createCollaborationRoom(env, ownerScope, { roomId, title: "Shared engineering", visibility: "shared", createdAt: Date.now() });
  await addCollaborationMember(env, ownerScope, roomId, { userId: member, displayName: "Member", actorId: humanActorId(member), kind: "human", createdAt: Date.now() });
  const profile = await createCustomAgent(env, `team:${workspace.workspaceId}`, "engineer", { name: "Engineer", harness: "opencode", instructions: "Use approved room facts." });
  await addCollaborationMember(env, ownerScope, roomId, { userId: owner, displayName: "Engineer", actorId: `agent:${profile.id}`, kind: "agent", profileVersion: 1, createdAt: Date.now() });
  const handoffId = "handoff-team-request";
  const handoff = await createRootCollaborationHandoff(env, scope, {
    ...scope, roomId, handoffId, taskId: "task-team", senderUserId: member, senderActorId: humanActorId(member),
    recipientUserId: owner, recipientActorId: `agent:${profile.id}`, profileVersion: 1,
    parentHandoffId: null, rootHandoffId: handoffId, depth: 0, ancestorHandoffIds: [], remainingBudget: 0,
    grantedCapabilities: ["room.read", "message.send"], status: "active", createdAt: Date.now(), cancelledAt: null,
  });
  expect(handoff).not.toBeNull();
  expect(await pinCollaborationHandoffExecutor(env, scope, handoffId, member)).toBe(true);
  let task = "Draft an engineering summary.";
  let noteId: string | undefined;
  if (withNote) {
    const note = await createCollaborationMemory(env, ownerScope, roomId, { id: "ctx_selected", title: "Approved context", content: "Use the approved release target." });
    noteId = note.id;
    task = (await freezeCollaborationContext(env, scope, roomId, handoffId, task, [], [{ id: note.id, version: note.version, sha256: note.sha256 }])).task;
  }
  const proof = { handoffId, actorId: member, executorAgentName: member, employeeId: profile.id, employeeVersion: 1, task, expectedWorkspaceId: workspace.workspaceId };
  return { ...db, env, profile, scope, ownerScope, roomId, handoffId, task, noteId, proof, forwarded, workspaceId: workspace.workspaceId };
}
const request = (workspaceId: string) => new Request("https://shiba.test/api/collaboration/rooms/room/handoffs", {
  method: "POST", headers: { origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": workspaceId }, body: "{}",
});

describe("authoritative team handoff intake", () => {
  it("refuses invited-account execution before any provider route, approval or sandbox can be created", async () => {
    const f = await fixture();
    auth.restricted = true;
    const response = await queueCollaborationRun(request(f.workspaceId), f.env, { task: f.task, repoUrl: "https://github.com/example/repo",
      customAgentId: f.profile.id, profileVersion: 1, commandId: f.handoffId, executorAgentName: member, collaborationHandoffId: f.handoffId });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining("personal-provider execution grants") });
    expect(f.forwarded).toEqual([]);
  });
  it("lets a room member request an owner-added employee and forwards exact server-pinned team scope", async () => {
    const f = await fixture(true);
    expect(await resolveTeamHandoffRunScope(f.env, f.proof)).toEqual({ orgId: `team:${f.workspaceId}`, workspaceId: f.workspaceId });
    const response = await queueCollaborationRun(request(f.workspaceId), f.env, { task: f.task,
      executionTarget: { kind: "artifact-workspace", expectedDeliverables: ["reports/summary.md"] },
      customAgentId: f.profile.id, profileVersion: 1, commandId: f.handoffId,
      executorAgentName: member, collaborationHandoffId: f.handoffId,
    });
    expect(response?.status).toBe(200);
    expect(f.forwarded).toEqual([{ owner: member, body: expect.objectContaining({
      orgId: `team:${f.workspaceId}`, customAgentId: f.profile.id, customAgentVersion: 1, collaborationHandoffId: f.handoffId, task: f.task,
    }) }]);
  });

  it.each([
    { actorId: owner }, { executorAgentName: owner }, { employeeId: "other-profile" },
    { employeeVersion: 2 }, { expectedWorkspaceId: "ws_222222222222222222222222" },
    { handoffId: "guessed-handoff" },
  ])("rejects a mismatched sender, executor, employee, version, workspace or handoff: %j", async (change) => {
    const f = await fixture();
    expect(await resolveTeamHandoffRunScope(f.env, { ...f.proof, ...change })).toBeNull();
  });

  it.each(["sender", "recipient", "room", "profile", "handoff"])("rejects current %s revocation before forwarding", async (kind) => {
    const f = await fixture();
    if (kind === "sender" || kind === "recipient") f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(f.workspaceId, kind === "sender" ? member : owner);
    if (kind === "room") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND actor_id=?").run(f.roomId, humanActorId(member));
    if (kind === "profile") f.sqlite.prepare("UPDATE org_custom_agents SET archived_at=1 WHERE id=?").run(f.profile.id);
    if (kind === "handoff") f.sqlite.prepare("UPDATE collaboration_handoffs SET status='cancelled' WHERE handoff_id=?").run(f.handoffId);
    expect(await resolveTeamHandoffRunScope(f.env, f.proof)).toBeNull();
    const response = await queueCollaborationRun(request(f.workspaceId), f.env, { task: f.task, repoUrl: "https://github.com/example/repo",
      customAgentId: f.profile.id, profileVersion: 1, commandId: f.handoffId, executorAgentName: member, collaborationHandoffId: f.handoffId });
    expect([403, 404]).toContain(response?.status);
    expect(f.forwarded).toEqual([]);
  });

  it("rechecks selected shared context before queue and rejects changed task text", async () => {
    const f = await fixture(true);
    expect(await resolveTeamHandoffRunScope(f.env, { ...f.proof, task: "Substituted task" })).toBeNull();
    await revokeCollaborationMemory(f.env, f.ownerScope, f.roomId, { id: f.noteId!, version: 1 });
    expect(await resolveTeamHandoffRunScope(f.env, f.proof)).toBeNull();
  });

  it("rejects ambiguous global handoff IDs in a corrupted legacy database", async () => {
    const f = await fixture();
    f.sqlite.exec("PRAGMA foreign_keys=OFF");
    const original = f.sqlite.prepare("SELECT * FROM collaboration_handoffs WHERE handoff_id=?").get(f.handoffId)!;
    const keys = Object.keys(original);
    f.sqlite.prepare(`INSERT INTO collaboration_handoffs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((key) => key === "tenant_id" ? "corrupted-other-tenant" : original[key]) as never[]);
    expect(await teamHandoffWorkspaceId(f.env, f.handoffId)).toBeNull();
    expect(await resolveTeamHandoffRunScope(f.env, f.proof)).toBeNull();
  });
});
