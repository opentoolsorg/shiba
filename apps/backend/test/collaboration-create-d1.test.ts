import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { addCollaborationMember, createCollaborationRoom, createRootCollaborationHandoff, humanActorId, removeCollaborationMember, type CollaborationScope } from "../src/collaboration-store.js";
import { createChannel, joinChannel, leaveChannel } from "../src/collaboration-v2-store.js";
import { attachHandoffReturn, reportPendingHandoff } from "../src/collaboration-handoff-return.js";
import { postRoomEvent } from "../src/collaboration-thread-post.js";
import type { Env } from "../src/env.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test" }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  resolveRequestIdentity: vi.fn(async () => ({ authorized: true, userId: auth.userId })),
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => auth.userId),
}));

interface D1Runtime {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
}

const scope: CollaborationScope = {
  tenantId: "self-hosted",
  workspaceId: "ws_0123456789abcdef01234567",
  userId: "owner@example.test",
};
let runtime: D1Runtime;
let db: D1Database;
let env: Env;

beforeAll(async () => {
  // Use Wrangler's pinned runtime rather than adding a second D1 implementation.
  const require = createRequire(await realpath(new URL("../../../node_modules/wrangler/package.json", import.meta.url)));
  // biome-ignore lint/correctness/noUndeclaredDependencies: Resolve the runtime shipped with Wrangler.
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare") as {
    Miniflare: new (options: unknown) => D1Runtime;
    convertV4MiniflareOptions(options: Record<string, unknown>): unknown;
  };
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("fixture"); } }',
    compatibilityDate: "2026-06-01",
    host: "127.0.0.1", port: 0, inspectorPort: 0,
    cf: false, telemetry: { enabled: false },
    d1Databases: ["AGENT_AUDIT"],
  }));
  db = await runtime.getD1Database("AGENT_AUDIT");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    // D1 exec treats newlines as statement boundaries; keep complete trigger bodies together.
    const sql = (await readFile(new URL(name, migrations), "utf8")).replace(/^\s*--.*$/gm, "").replace(/\n/g, " ");
    await db.exec(sql);
  }
  await db.prepare("INSERT INTO team_workspaces (tenant_id,workspace_id,name,version,created_at) VALUES (?,?,?,1,1)")
    .bind(scope.tenantId, scope.workspaceId, "D1 fixture").run();
  for (const [userId, role] of [[scope.userId, "owner"], ["member@example.test", "member"]]) {
    await db.prepare("INSERT INTO team_workspace_memberships (tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES (?,?,?,?,'active',1,1)")
      .bind(scope.tenantId, scope.workspaceId, userId, role).run();
  }
  env = { AGENT_AUDIT: db } as Env;
}, 60_000);

afterAll(async () => { if (runtime) await runtime.dispose(); });

async function owners(roomId: string) {
  return (await db.prepare("SELECT actor_id FROM collaboration_memberships WHERE tenant_id=? AND workspace_id=? AND room_id=? AND role='owner' AND status='active'")
    .bind(scope.tenantId, scope.workspaceId, roomId).all()).results;
}

async function send(path: string, method = "GET", body?: unknown) {
  const response = await handleCollaboration(new Request(`https://worker.test/api/collaboration${path}`, {
    method,
    headers: { "content-type": "application/json", origin: "https://worker.test", "X-Shiba-Workspace": scope.workspaceId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  if (!response) throw new Error("route not handled");
  return response;
}

describe("collaboration creates with all migrations on real D1", () => {
  it("returns the room and one owner despite trigger-inflated write counts", async () => {
    const probe = await db.prepare("INSERT INTO collaboration_rooms (room_id,tenant_id,workspace_id,title,visibility,created_by_user_id,created_at) VALUES (?,?,?,?,'private',?,1)")
      .bind("count_probe", scope.tenantId, scope.workspaceId, "Count probe", scope.userId).run();
    expect(probe.meta.changes).toBeGreaterThan(1);
    const room = await createCollaborationRoom(env, scope, { roomId: "room_d1", title: "D1 room", visibility: "private", createdAt: 2 });
    expect(room).toMatchObject({ roomId: "room_d1", title: "D1 room", memberCount: 1 });
    expect(await owners(room.roomId)).toEqual([{ actor_id: humanActorId(scope.userId) }]);
    expect(await db.prepare("SELECT title FROM workspace_search_docs WHERE tenant_id=? AND workspace_id=? AND doc_id=?")
      .bind(scope.tenantId, scope.workspaceId, room.roomId).first()).toEqual({ title: "D1 room" });
  });

  it("returns the channel and one owner", async () => {
    const channel = await createChannel(env, scope, { roomId: "channel_d1", title: "D1 channel", createdAt: 3 });
    expect(channel).toMatchObject({ roomId: "channel_d1", title: "D1 channel", kind: "channel" });
    expect(await owners(channel.roomId)).toEqual([{ actor_id: humanActorId(scope.userId) }]);
  });

  it.each(["room", "channel"])("refuses a nonmember %s create without writing rows", async (kind) => {
    const outsider = { ...scope, userId: "outsider@example.test" };
    const input = { roomId: `denied_${kind}`, title: "Denied", visibility: "private" as const, createdAt: 4 };
    await expect(kind === "room" ? createCollaborationRoom(env, outsider, input) : createChannel(env, outsider, input))
      .rejects.toMatchObject({ status: 404 });
    expect(await db.prepare("SELECT room_id FROM collaboration_rooms WHERE room_id=?").bind(input.roomId).first()).toBeNull();
    expect(await owners(input.roomId)).toEqual([]);
  });

  it("returns HTTP 201 and lists each new room and channel once", async () => {
    for (const [path, key] of [["rooms", "room"], ["channels", "channel"]] as const) {
      const title = `HTTP ${key}`;
      const created = await send(`/${path}`, "POST", { title, visibility: "private" });
      expect(created.status).toBe(201);
      const body = await created.json() as Record<string, { roomId: string }>;
      const createdRoom = body[key];
      if (!createdRoom) throw new Error("created room missing");
      expect(await owners(createdRoom.roomId)).toEqual([{ actor_id: humanActorId(scope.userId) }]);
      const listing = await send(path === "rooms" ? "/rooms" : "/channels/public");
      const listed = await listing.json() as Record<string, Array<{ roomId: string }>>;
      expect((listed[path] ?? []).filter((row) => row.roomId === createdRoom.roomId)).toHaveLength(1);
    }
  });

  it("keeps channel join and leave no-op results accurate", async () => {
    await createChannel(env, scope, { roomId: "join_channel_d1", title: "Join channel", createdAt: 3 });
    const member = { ...scope, userId: "member@example.test" };
    expect(await joinChannel(env, member, "join_channel_d1", 5)).toBe(true);
    expect(await joinChannel(env, member, "join_channel_d1", 6)).toBe(false);
    expect(await leaveChannel(env, member, "join_channel_d1", 7)).toBe(true);
    expect(await leaveChannel(env, scope, "join_channel_d1", 8)).toBe(false);
  });
  it("adds and removes members while preserving no-op results", async () => {
    const roomId = "member_room_d1";
    await createCollaborationRoom(env, scope, { roomId, title: "Members", visibility: "private", createdAt: 1 });
    const member = { userId: "member@example.test", displayName: "Member", actorId: humanActorId("member@example.test"), kind: "human" as const, createdAt: 2 };
    expect(await addCollaborationMember(env, scope, roomId, member)).toBe(true);
    expect(await addCollaborationMember(env, scope, roomId, member)).toBe(false);
    expect((await removeCollaborationMember(env, scope, roomId, member.actorId, 3)).changed).toBe(true);
    expect((await removeCollaborationMember(env, scope, roomId, member.actorId, 4)).changed).toBe(false);
  });

  it("reports a handoff once when message triggers write search and thread rows", async () => {
    const roomId = "handoff_room_d1";
    await createCollaborationRoom(env, scope, { roomId, title: "Handoff", visibility: "private", createdAt: 1 });
    for (const actor of ["parent", "child"]) {
      expect(await addCollaborationMember(env, scope, roomId, {
        userId: scope.userId, displayName: actor, actorId: `agent:${actor}`, kind: "agent", profileVersion: 1, createdAt: 2,
      })).toBe(true);
    }
    const parent = await postRoomEvent(env, scope, { roomId, threadRootId: null, kind: "text", body: "Parent task", now: 3 });
    const child = await postRoomEvent(env, scope, { roomId, threadRootId: null, kind: "text", body: "Child task", now: 4 });
    const handoffId = "handoff_d1";
    expect(await createRootCollaborationHandoff(env, scope, {
      handoffId, tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId, taskId: "task_return",
      senderUserId: scope.userId, senderActorId: "agent:parent", recipientUserId: scope.userId, recipientActorId: "agent:child",
      parentHandoffId: null, rootHandoffId: handoffId, depth: 0, ancestorHandoffIds: [], remainingBudget: 4,
      grantedCapabilities: ["room.read", "message.send"], profileVersion: 1, status: "active", createdAt: 5, cancelledAt: null,
    })).not.toBeNull();
    await attachHandoffReturn(env, scope, {
      handoffId, parentRoomId: roomId, parentThreadRootId: parent.messageId, parentActorId: "agent:parent",
      childRoomId: roomId, childThreadRootId: child.messageId, createdAt: 6,
    });
    const input = { childRoomId: roomId, childThreadRootId: child.messageId, resultMessageId: "result_d1", resultBody: "Done", now: 7 };
    expect((await reportPendingHandoff(env, scope, input)).reported).toBe(true);
    expect((await reportPendingHandoff(env, scope, { ...input, now: 8 })).reported).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM collaboration_messages WHERE room_id=? AND message_kind='handoff_report'").bind(roomId).first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT reply_count FROM collaboration_messages WHERE room_id=? AND message_id=?").bind(roomId, parent.messageId).first()).toEqual({ reply_count: 1 });
  });

});
