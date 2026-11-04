import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTeamCollaborationScope } from "../src/team-collaboration-scope.js";
import { canReadCollaborationRoom, collaborationRoomName, notifyCollaborationHandoffChange } from "../src/collaboration-room-access.js";
import { addCollaborationMember, createCollaborationRoom, createRootCollaborationHandoff, humanActorId, type CollaborationHandoffRow } from "../src/collaboration-store.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test" as string | null, authorized: true }));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => auth.authorized, resolveUserId: async () => auth.userId }));
const OWNER = "owner@example.test", MEMBER = "member@example.test";
const ROOM = `room_${"a".repeat(24)}`;
const databases: Array<ReturnType<typeof customAgentD1>["sqlite"]> = [];
beforeEach(() => { auth.userId = OWNER; auth.authorized = true; });
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const request = (query = "", headers: Record<string, string> = {}) => new Request(`https://dashboard.test/api/collaboration/rooms${query}`, { headers });
async function fixture() {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  const notify = vi.fn(async () => {});
  const getByName = vi.fn(() => ({ notifyCollaborationChange: notify }));
  const env = { AGENT_AUDIT: database, ConversationRoom: { getByName } } as unknown as Env;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Product" });
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email: MEMBER, role: "member" });
  await acceptTeamWorkspaceInvitation(env, MEMBER, invite.token);
  const scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OWNER };
  await createCollaborationRoom(env, scope, { roomId: ROOM, title: "Product tasks", visibility: "shared", createdAt: 1 });
  await addCollaborationMember(env, scope, ROOM, { userId: MEMBER, actorId: humanActorId(MEMBER), displayName: "Member", kind: "human", createdAt: 2 });
  return { env, sqlite, scope, workspaceId: workspace.workspaceId, getByName, notify };
}

describe("verified collaboration workspace selection", () => {
  it("preserves the legacy workspace only for an authenticated existing identity", async () => {
    const env = {} as Env;
    expect(await resolveTeamCollaborationScope(request(), env)).toEqual({ tenantId: "self-hosted", workspaceId: "default", userId: OWNER });
    auth.userId = " Owner@Example.Test ";
    expect(await resolveTeamCollaborationScope(request("?workspaceId=default", { "X-Shiba-Workspace": "default" }), env)).toMatchObject({ userId: OWNER });
    auth.userId = null;
    expect(await resolveTeamCollaborationScope(request(), env)).toBeNull();
    auth.userId = OWNER; auth.authorized = false;
    expect(await resolveTeamCollaborationScope(request(), env)).toBeNull();
  });

  it("accepts matching header/query selectors for current members only", async () => {
    const f = await fixture();
    for (const req of [request("", { "X-Shiba-Workspace": f.workspaceId }), request(`?workspaceId=${f.workspaceId}`),
      request(`?workspaceId=${f.workspaceId}`, { "X-Shiba-Workspace": f.workspaceId })]) {
      expect(await resolveTeamCollaborationScope(req, f.env)).toEqual(f.scope);
    }
    auth.userId = MEMBER;
    expect(await resolveTeamCollaborationScope(request(`?workspaceId=${f.workspaceId}`), f.env)).toMatchObject({ userId: MEMBER, workspaceId: f.workspaceId });
    auth.userId = "outsider@example.test";
    expect(await resolveTeamCollaborationScope(request(`?workspaceId=${f.workspaceId}`, { "X-Agent-Principal": OWNER, "X-Shiba-Role": "owner" }), f.env)).toBeNull();
  });

  it.each(["?workspaceId=default&workspaceId=default", "?workspaceId=", "?workspaceId=ws_ABC", "?workspaceId=../default", "?workspaceId=Default"])("rejects malformed or duplicate selectors %s without a default fallback", async (query) => {
    expect(await resolveTeamCollaborationScope(request(query), {} as Env)).toBeNull();
  });

  it("rejects conflicting selectors and cross-workspace use even for a different workspace's owner", async () => {
    const f = await fixture();
    const other = await createTeamWorkspace(f.env, "other@example.test", { name: "Other" });
    expect(await resolveTeamCollaborationScope(request("?workspaceId=default", { "X-Shiba-Workspace": f.workspaceId }), f.env)).toBeNull();
    expect(await resolveTeamCollaborationScope(request(`?workspaceId=${other.workspaceId}`), f.env)).toBeNull();
    expect(await resolveTeamCollaborationScope(request("", { "X-Shiba-Workspace": "default, default" }), f.env)).toBeNull();
    auth.userId = "other@example.test";
    expect(await canReadCollaborationRoom(f.env, { ...f.scope, roomId: ROOM }, auth.userId)).toBe(false);
    expect(await canReadCollaborationRoom(f.env, { ...f.scope, workspaceId: other.workspaceId, roomId: ROOM }, auth.userId)).toBe(false);
  });

  it("requires both current workspace and current human room grants, independent of a workspace role label", async () => {
    const f = await fixture();
    const identity = { tenantId: f.scope.tenantId, workspaceId: f.workspaceId, roomId: ROOM };
    expect(await canReadCollaborationRoom(f.env, identity, MEMBER)).toBe(true);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE user_id=?").run(MEMBER);
    auth.userId = MEMBER;
    expect(await resolveTeamCollaborationScope(request(`?workspaceId=${f.workspaceId}`), f.env)).toBeNull();
    expect(await canReadCollaborationRoom(f.env, identity, MEMBER)).toBe(false);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='active',role='owner' WHERE user_id=?").run(MEMBER);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE user_id=?").run(MEMBER);
    expect(await canReadCollaborationRoom(f.env, identity, MEMBER)).toBe(false);
  });

  it("notifies the handoff's actual scoped room and refuses ambiguous identifiers", async () => {
    const f = await fixture();
    const handoff: CollaborationHandoffRow = { ...f.scope, handoffId: "scoped-handoff", roomId: ROOM, taskId: "task", senderUserId: OWNER,
      senderActorId: humanActorId(OWNER), recipientUserId: MEMBER, recipientActorId: humanActorId(MEMBER), parentHandoffId: null,
      rootHandoffId: "scoped-handoff", depth: 0, ancestorHandoffIds: [], remainingBudget: 0,
      grantedCapabilities: ["room.read"], profileVersion: null, status: "active", createdAt: 3, cancelledAt: null };
    expect(await createRootCollaborationHandoff(f.env, f.scope, handoff)).not.toBeNull();
    await notifyCollaborationHandoffChange(f.env, handoff.handoffId);
    const identity = { tenantId: f.scope.tenantId, workspaceId: f.workspaceId, roomId: ROOM };
    expect(f.getByName).toHaveBeenCalledWith(collaborationRoomName(identity));
    expect(f.notify).toHaveBeenCalledWith(identity);
    f.getByName.mockClear(); f.notify.mockClear();
    // Malformed legacy/corrupt state must not select the first workspace row.
    const defaultScope = { ...f.scope, workspaceId: "default" };
    const defaultRoom = `room_${"b".repeat(24)}`;
    await createCollaborationRoom(f.env, defaultScope, { roomId: defaultRoom, title: "Legacy", visibility: "shared", createdAt: 1 });
    await addCollaborationMember(f.env, defaultScope, defaultRoom, { userId: MEMBER, actorId: humanActorId(MEMBER), displayName: "Member", kind: "human", createdAt: 2 });
    const columns = f.sqlite.prepare("PRAGMA table_info(collaboration_handoffs)").all().map((row) => String(row.name));
    const selected = columns.map((column) => column === "workspace_id" ? "'default'" : column === "room_id" ? `'${defaultRoom}'` : column).join(",");
    f.sqlite.prepare(`INSERT INTO collaboration_handoffs (${columns.join(",")}) SELECT ${selected} FROM collaboration_handoffs WHERE handoff_id=?`).run(handoff.handoffId);
    await notifyCollaborationHandoffChange(f.env, handoff.handoffId);
    expect(f.getByName).not.toHaveBeenCalled();
  });
});
