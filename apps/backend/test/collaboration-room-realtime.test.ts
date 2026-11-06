import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRoom } from "../src/conversation-room-do.js";
import { handleCollaborationWithRealtime } from "../src/collaboration-room-routes.js";
import { canReadCollaborationRoom, collaborationRoomName, notifyCollaborationHandoffChange } from "../src/collaboration-room-access.js";
import { addCollaborationMember, createCollaborationRoom, removeCollaborationMember } from "../src/collaboration-store.js";
import { authenticatedRoomViewerId } from "../src/run-room-events.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => auth.authorized),
  resolveUserId: vi.fn(async () => auth.userId),
}));

const databases: DatabaseSync[] = [];
beforeEach(() => { auth.userId = "owner@example.test"; auth.authorized = true; });
afterEach(() => { for (const database of databases.splice(0)) database.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const identity = { tenantId: "self-hosted", workspaceId: "default", roomId: "room_111111111111111111111111" };
const scope = { tenantId: identity.tenantId, workspaceId: identity.workspaceId, userId: "owner@example.test" };

class Socket {
  readyState = 1;
  attachment: unknown;
  events: Array<Record<string, unknown>> = [];
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(raw: string) { this.events.push(JSON.parse(raw) as Record<string, unknown>); }
  close = vi.fn((_code: number, _reason: string) => { this.readyState = 3; });
}

async function fixture() {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await createCollaborationRoom(env, scope, { roomId: identity.roomId, title: "Shared context", visibility: "shared", createdAt: 1 });
  await addCollaborationMember(env, scope, identity.roomId, { userId: "teammate@example.test", actorId: "human:teammate@example.test", displayName: "Teammate", kind: "human", createdAt: 2 });
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sockets: Socket[] = [];
  const ctx = {
    storage: { sql: { exec<T>(sql: string, ...values: SQLInputValue[]) { const rows = db.prepare(sql).all(...values) as T[]; return { toArray: () => rows }; } }, setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) },
    getWebSockets: () => sockets.filter((socket) => socket.readyState === 1),
    acceptWebSocket: (socket: Socket) => { sockets.push(socket); },
  } as unknown as DurableObjectState;
  const room = new ConversationRoom(ctx, env);
  const addSocket = async (userId: string, nonce = "22222222-2222-4222-8222-222222222222", roomIdentity = identity) => {
    const socket = new Socket();
    socket.serializeAttachment({ ownerId: `collaboration:${roomIdentity.tenantId}:${roomIdentity.workspaceId}`, actorId: userId, sessionId: roomIdentity.roomId, viewerId: await authenticatedRoomViewerId(userId, nonce), joinedAt: 1, typing: false, typingAt: 0, connectionId: crypto.randomUUID(), cursor: null, cursorAt: 0, collaboration: roomIdentity });
    sockets.push(socket);
    return socket;
  };
  return { env, room, sockets, addSocket, db, sqlite, ctx };
}

function upgrade(extra: Record<string, string> = {}, origin = "https://worker.test") {
  return new Request(`https://worker.test/api/collaboration/rooms/${identity.roomId}/realtime?viewer=22222222-2222-4222-8222-222222222222`, { headers: { Upgrade: "websocket", Origin: origin, ...extra } });
}

describe("authenticated shared-room realtime", () => {
  it("shares normalized cursors across authenticated members using only server-owned identity", async () => {
    const { room, addSocket, db } = await fixture();
    const owner = await addSocket(scope.userId), teammate = await addSocket("teammate@example.test");
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .25, y: .75 }, actorId: scope.userId, viewerId: "forged-owner" }));
    const viewers = owner.events.at(-1)?.viewers as Array<{ viewerId: string; label: string; cursor: unknown }>;
    expect(viewers).toContainEqual(expect.objectContaining({ viewerId: (teammate.deserializeAttachment() as { viewerId: string }).viewerId, label: "teammate@example.test", cursor: { x: .25, y: .75 } }));
    expect(viewers.find((viewer) => viewer.label === scope.userId)?.cursor).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_messages").get()?.count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()?.count).toBe(0);
  });
  it("rejects malformed/out-of-bounds cursor frames and an unattached sender", async () => {
    const { room, addSocket } = await fixture(); const owner = await addSocket(scope.userId), teammate = await addSocket("teammate@example.test");
    for (const cursor of [{ x: -1, y: .5 }, { x: .5, y: 2 }, { x: null, y: .5 }, { x: .5 }, { x: .5, y: .5, command: "execute" }, "position"]) {
      await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor }));
    }
    expect(teammate.events.every((event) => event.type === "error")).toBe(true); expect(owner.events).toEqual([]);
    const anonymous = new Socket(); await room.webSocketMessage(anonymous as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .5, y: .5 } }));
    expect(anonymous.close).toHaveBeenCalledWith(1008, "Room identity is unavailable.");
  });
  it("bounds movement publication and clears cursors on leave, expiry and offline", async () => {
    const { room, addSocket } = await fixture(); const owner = await addSocket(scope.userId), teammate = await addSocket("teammate@example.test");
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let index = 0; index < 30; index++) await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .25, y: .75 } }));
    for (let index = 0; index < 30; index++) await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", typing: index % 2 === 0, cursor: { x: .5, y: .5 } }));
    expect(owner.events).toHaveLength(1);
    now += 100; await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .5, y: .5 } })); expect(owner.events).toHaveLength(2);
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: null }));
    expect((owner.events.at(-1)?.viewers as Array<{ cursor: unknown }>).every((viewer) => viewer.cursor === null)).toBe(true);
    now += 100; await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .4, y: .6 } }));
    now += 15_001; await room.alarm(); expect((owner.events.at(-1)?.viewers as Array<{ cursor: unknown }>).every((viewer) => viewer.cursor === null)).toBe(true);
    teammate.readyState = 3; await room.webSocketClose(); expect(JSON.stringify(owner.events.at(-1))).not.toContain("teammate@example.test");
  });
  it("rechecks room membership on cursor send and delivery after revocation", async () => {
    const { room, env, addSocket } = await fixture(); const owner = await addSocket(scope.userId), teammate = await addSocket("teammate@example.test");
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .1, y: .2 } }));
    owner.events = []; teammate.events = [];
    await removeCollaborationMember(env, scope, identity.roomId, "human:teammate@example.test", Date.now());
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .3, y: .4 } }));
    expect(teammate.close).toHaveBeenCalledWith(1008, "Room access ended."); expect(teammate.events).toEqual([]);
    expect(JSON.stringify(owner.events)).not.toContain("teammate@example.test"); owner.events = [];
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .6, y: .7 } })); expect(owner.events).toEqual([]);
  });
  it("removes cursor delivery when workspace membership ends even if the room grant remains", async () => {
    const { room, env, addSocket, sqlite } = await fixture();
    const workspace = await createTeamWorkspace(env, scope.userId, { name: "Cursor team" });
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, scope.userId, { email: "teammate@example.test", role: "member" });
    await acceptTeamWorkspaceInvitation(env, "teammate@example.test", invite.token);
    const teamScope = { ...scope, workspaceId: workspace.workspaceId }, teamIdentity = { ...identity, workspaceId: workspace.workspaceId, roomId: `room_${"b".repeat(24)}` };
    await createCollaborationRoom(env, teamScope, { roomId: teamIdentity.roomId, title: "Cursor team", visibility: "shared", createdAt: 1 });
    await addCollaborationMember(env, teamScope, teamIdentity.roomId, { userId: "teammate@example.test", actorId: "human:teammate@example.test", displayName: "Teammate", kind: "human", createdAt: 2 });
    const owner = await addSocket(scope.userId, crypto.randomUUID(), teamIdentity), teammate = await addSocket("teammate@example.test", crypto.randomUUID(), teamIdentity);
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .2, y: .3 } }));
    owner.events = []; teammate.events = [];
    sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(workspace.workspaceId, "teammate@example.test");
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: .7, y: .8 } }));
    expect(teammate.close).toHaveBeenCalledWith(1008, "Room access ended."); expect(teammate.events).toEqual([]); expect(JSON.stringify(owner.events)).not.toContain("teammate@example.test");
  });
  it("routes a team room using only the verified workspace selector and current member grant", async () => {
    const { env, sqlite } = await fixture();
    const workspace = await createTeamWorkspace(env, scope.userId, { name: "Product" });
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, scope.userId, { email: "teammate@example.test", role: "member" });
    await acceptTeamWorkspaceInvitation(env, "teammate@example.test", invite.token);
    const teamScope = { ...scope, workspaceId: workspace.workspaceId };
    const teamIdentity = { tenantId: scope.tenantId, workspaceId: workspace.workspaceId, roomId: `room_${"a".repeat(24)}` };
    await createCollaborationRoom(env, teamScope, { roomId: teamIdentity.roomId, title: "Team room", visibility: "shared", createdAt: 1 });
    await addCollaborationMember(env, teamScope, teamIdentity.roomId, { userId: "teammate@example.test", actorId: "human:teammate@example.test", displayName: "Teammate", kind: "human", createdAt: 2 });
    const requests: Request[] = [];
    const getByName = vi.fn((_name: string) => ({ fetch: async (request: Request) => { requests.push(request); return new Response(null); } }));
    env.ConversationRoom = { getByName } as unknown as Env["ConversationRoom"];
    const teamUpgrade = (query: string, headers: Record<string, string> = {}) => new Request(`https://worker.test/api/collaboration/rooms/${teamIdentity.roomId}/realtime?viewer=${crypto.randomUUID()}${query}`, {
      headers: { Upgrade: "websocket", Origin: "https://worker.test", ...headers },
    });
    expect((await handleCollaborationWithRealtime(teamUpgrade(""), env))?.status).toBe(404);
    for (const user of [scope.userId, "teammate@example.test"]) {
      auth.userId = user;
      expect((await handleCollaborationWithRealtime(teamUpgrade(`&workspaceId=${workspace.workspaceId}`), env))?.status).toBe(200);
    }
    expect(getByName.mock.calls.every(([name]) => name === collaborationRoomName(teamIdentity))).toBe(true);
    expect(requests.every((request) => request.headers.get("x-shiba-room-workspace") === workspace.workspaceId)).toBe(true);
    expect(requests[0]!.headers.get("x-shiba-room-viewer")).not.toBe(requests[1]!.headers.get("x-shiba-room-viewer"));
    expect((await handleCollaborationWithRealtime(teamUpgrade(`&workspaceId=${workspace.workspaceId}`, { "X-Shiba-Workspace": "default" }), env))?.status).toBe(404);
    expect((await handleCollaborationWithRealtime(teamUpgrade(`&workspaceId=${workspace.workspaceId}&workspaceId=${workspace.workspaceId}`), env))?.status).toBe(404);
    sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(workspace.workspaceId, auth.userId);
    expect((await handleCollaborationWithRealtime(teamUpgrade(`&workspaceId=${workspace.workspaceId}`), env))?.status).toBe(404);
    expect(requests).toHaveLength(2);
  });

  it("accepts the actual room identifier minted by the HTTP creation route", async () => {
    const { env } = await fixture();
    const created = await handleCollaborationWithRealtime(new Request("https://worker.test/api/collaboration/rooms", { method: "POST", headers: { Origin: "https://worker.test", "Content-Type": "application/json" }, body: JSON.stringify({ title: "Created through the real API" }) }), env);
    expect(created?.status).toBe(201);
    const body = await created!.json() as { room: { roomId: string } };
    expect(body.room.roomId).toMatch(/^room_[a-f0-9]{24}$/);
    const fetch = vi.fn(async () => new Response(null));
    env.ConversationRoom = { getByName: () => ({ fetch }) } as unknown as Env["ConversationRoom"];
    const request = new Request(`https://worker.test/api/collaboration/rooms/${body.room.roomId}/realtime?viewer=${crypto.randomUUID()}`, { headers: { Upgrade: "websocket", Origin: "https://worker.test" } });
    expect((await handleCollaborationWithRealtime(request, env))?.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("routes independent authenticated members to one room with server-attributed distinct identities", async () => {
    const { env } = await fixture();
    const requests: Request[] = [];
    const names: string[] = [];
    env.ConversationRoom = { getByName: (name: string) => { names.push(name); return { fetch: async (request: Request) => { requests.push(request); return new Response(null); } }; } } as unknown as Env["ConversationRoom"];
    for (const userId of ["owner@example.test", "teammate@example.test"]) {
      auth.userId = userId;
      expect((await handleCollaborationWithRealtime(upgrade({ "x-shiba-room-actor": "attacker", "x-shiba-room-owner": "attacker", "x-shiba-room-run": "run-secret" }), env))?.status).toBe(200);
    }
    expect(names).toEqual([collaborationRoomName(identity), collaborationRoomName(identity)]);
    expect(requests.map((request) => request.headers.get("x-shiba-room-actor"))).toEqual(["owner@example.test", "teammate@example.test"]);
    expect(requests[0]!.headers.get("x-shiba-room-viewer")).not.toBe(requests[1]!.headers.get("x-shiba-room-viewer"));
    expect(requests.every((request) => request.headers.get("x-shiba-room-run") === null && new URL(request.url).pathname === "/internal/collaboration-room")).toBe(true);
  });

  it("rejects unauthenticated, outsider, wrong-origin and removed-member upgrades", async () => {
    const { env } = await fixture();
    auth.authorized = false;
    expect((await handleCollaborationWithRealtime(upgrade(), env))?.status).toBe(401);
    auth.authorized = true;
    expect((await handleCollaborationWithRealtime(upgrade({}, "https://attacker.test"), env))?.status).toBe(403);
    auth.userId = "outsider@example.test";
    expect((await handleCollaborationWithRealtime(upgrade(), env))?.status).toBe(404);
    auth.userId = "teammate@example.test";
    await removeCollaborationMember(env, scope, identity.roomId, `human:${auth.userId}`, 3);
    expect((await handleCollaborationWithRealtime(upgrade(), env))?.status).toBe(404);
    expect(await canReadCollaborationRoom(env, { ...identity, tenantId: "other" }, "owner@example.test")).toBe(false);
  });

  it("rechecks the grant inside the DO before accepting an upgrade", async () => {
    const { room, env } = await fixture();
    await removeCollaborationMember(env, scope, identity.roomId, "human:teammate@example.test", 3);
    const response = await room.fetch(new Request("https://internal/internal/collaboration-room", { headers: { Upgrade: "websocket", "x-shiba-room-tenant": identity.tenantId, "x-shiba-room-workspace": identity.workspaceId, "x-shiba-room-session": identity.roomId, "x-shiba-room-actor": "teammate@example.test", "x-shiba-room-viewer": crypto.randomUUID() } }));
    expect(response.status).toBe(404);
  });

  it("enforces the live connection bound when another upgrade arrives during authorization", async () => {
    const { room, ctx, sockets, addSocket } = await fixture();
    for (let index = 0; index < 64; index++) await addSocket(scope.userId, crypto.randomUUID());
    // The asynchronous authorization scan starts at 63. A concurrent upgrade
    // completes before that scan resumes, so only a fresh synchronous count is safe.
    ctx.getWebSockets = vi.fn().mockReturnValueOnce(sockets.slice(0, 63)).mockReturnValue(sockets as unknown as WebSocket[]);
    const response = await room.fetch(new Request("https://internal/internal/collaboration-room", { headers: { Upgrade: "websocket", "x-shiba-room-tenant": identity.tenantId, "x-shiba-room-workspace": identity.workspaceId, "x-shiba-room-session": identity.roomId, "x-shiba-room-actor": scope.userId, "x-shiba-room-viewer": crypto.randomUUID() } }));
    expect(response.status).toBe(429);
    expect(sockets).toHaveLength(64);
  });

  it("shares authenticated presence and rejects message, execution, approval and server-frame forgery", async () => {
    const { room, addSocket, db } = await fixture();
    const owner = await addSocket("owner@example.test");
    const teammate = await addSocket("teammate@example.test");
    await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type: "client_presence", typing: true, actorId: "owner@example.test", viewerId: owner.deserializeAttachment() }));
    const presence = owner.events.find((event) => event.type === "collaboration:presence");
    expect(presence?.viewers).toEqual(expect.arrayContaining([expect.objectContaining({ label: "owner@example.test", typing: false }), expect.objectContaining({ label: "teammate@example.test", typing: true })]));
    owner.events = []; teammate.events = [];
    for (const type of ["message", "prompt_input", "stream:start", "run:event", "approval:decide", "collaboration:refresh", "subscribe"]) {
      await room.webSocketMessage(teammate as unknown as WebSocket, JSON.stringify({ type, messageId: "forged", text: "secret", runId: "guessed", after: 0 }));
    }
    expect(teammate.events.every((event) => event.type === "error")).toBe(true);
    expect(owner.events).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_messages").get()?.count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()?.count).toBe(0);
  });

  it("closes a removed idle member before the next broadcast and on the periodic alarm after restart", async () => {
    const { room, env, ctx, addSocket } = await fixture();
    const owner = await addSocket("owner@example.test");
    const teammate = await addSocket("teammate@example.test");
    await room.notifyCollaborationChange(identity);
    expect(ctx.storage.setAlarm).toHaveBeenCalled();
    owner.events = []; teammate.events = [];
    await removeCollaborationMember(env, scope, identity.roomId, "human:teammate@example.test", 3);
    const restarted = new ConversationRoom(ctx, env);
    await restarted.alarm();
    expect(teammate.close).toHaveBeenCalledWith(1008, "Room access ended.");
    expect(teammate.events).toEqual([]);
    await restarted.notifyCollaborationChange(identity);
    expect(owner.events).toContainEqual({ type: "collaboration:refresh", roomId: identity.roomId });
    expect(JSON.stringify(owner.events)).not.toContain("teammate@example.test");
    expect(teammate.events).toEqual([]);
  });

  it("closes every socket if retained Slack context loses its authorized audience", async () => {
    const { env, room, addSocket, sqlite } = await fixture();
    env.SLACK_CANVAS_OWNERS = JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: scope.userId, viewerIds: ["teammate@example.test"] }]);
    sqlite.prepare("INSERT INTO collaboration_slack_room_links (link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("link-1", identity.tenantId, identity.workspaceId, identity.roomId, scope.userId, "T1", "C1", "1.1", "revoked", 1, 2);
    const owner = await addSocket(scope.userId);
    const teammate = await addSocket("teammate@example.test");
    await room.notifyCollaborationChange(identity);
    expect(owner.events.some((event) => event.type === "collaboration:refresh")).toBe(true);
    owner.events = []; teammate.events = [];
    env.SLACK_CANVAS_OWNERS = "[]";
    await room.alarm();
    expect(owner.close).toHaveBeenCalledWith(1008, "Room access ended.");
    expect(teammate.close).toHaveBeenCalledWith(1008, "Room access ended.");
    expect(owner.events).toEqual([]);
    expect(teammate.events).toEqual([]);
  });

  it("notifies only after an accepted durable HTTP message, with no message body on the socket", async () => {
    const { env, room, addSocket, sqlite } = await fixture();
    const owner = await addSocket("owner@example.test");
    const teammate = await addSocket("teammate@example.test");
    const notify = vi.fn(async () => {
      expect(sqlite.prepare("SELECT body FROM collaboration_messages").get()?.body).toBe("Durable shared note");
      await room.notifyCollaborationChange(identity);
    });
    env.ConversationRoom = { getByName: () => ({ notifyCollaborationChange: notify }) } as unknown as Env["ConversationRoom"];
    const response = await handleCollaborationWithRealtime(new Request(`https://worker.test/api/collaboration/rooms/${identity.roomId}/messages`, { method: "POST", headers: { Origin: "https://worker.test", "Content-Type": "application/json" }, body: JSON.stringify({ body: "Durable shared note" }) }), env);
    expect(response?.status).toBe(201);
    expect(notify).toHaveBeenCalledOnce();
    for (const socket of [owner, teammate]) {
      expect(socket.events).toContainEqual({ type: "collaboration:refresh", roomId: identity.roomId });
      expect(JSON.stringify(socket.events)).not.toContain("Durable shared note");
    }
    const denied = await handleCollaborationWithRealtime(new Request(`https://worker.test/api/collaboration/rooms/${identity.roomId}/messages`, { method: "POST", headers: { Origin: "https://attacker.test", "Content-Type": "application/json" }, body: JSON.stringify({ body: "Denied" }) }), env);
    expect(denied?.status).toBe(403);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("invalidates the exact room after cancellation and an internal settlement hint", async () => {
    const { env, sqlite } = await fixture();
    const notify = vi.fn(async () => {});
    const getByName = vi.fn(() => ({ notifyCollaborationChange: notify }));
    env.ConversationRoom = { getByName } as unknown as Env["ConversationRoom"];
    const created = await handleCollaborationWithRealtime(new Request(`https://worker.test/api/collaboration/rooms/${identity.roomId}/handoffs`, { method: "POST", headers: { Origin: "https://worker.test", "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: "notify-handoff", taskId: "shared-task", recipientActorId: "human:teammate@example.test", budget: 1 }) }), env);
    expect(created?.status).toBe(201);
    notify.mockClear(); getByName.mockClear();
    const cancelled = await handleCollaborationWithRealtime(new Request("https://worker.test/api/collaboration/handoffs/notify-handoff/cancel", { method: "POST", headers: { Origin: "https://worker.test", "Content-Type": "application/json" }, body: "{}" }), env);
    expect(cancelled?.status).toBe(200);
    expect(await cancelled!.json()).toMatchObject({ roomId: identity.roomId, cancelled: true });
    expect(sqlite.prepare("SELECT status FROM collaboration_handoffs WHERE handoff_id=?").get("notify-handoff")?.status).toBe("cancelled");
    expect(getByName).toHaveBeenCalledWith(collaborationRoomName(identity));
    expect(notify).toHaveBeenCalledWith(identity);
    notify.mockClear(); getByName.mockClear();
    await notifyCollaborationHandoffChange(env, "notify-handoff");
    expect(getByName).toHaveBeenCalledWith(collaborationRoomName(identity));
    expect(notify).toHaveBeenCalledWith(identity);
    notify.mockClear(); getByName.mockClear();
    await notifyCollaborationHandoffChange(env, "unknown-handoff");
    expect(getByName).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
