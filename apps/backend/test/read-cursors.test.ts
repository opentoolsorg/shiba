import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationRoom, ensureCollaborationSchema, humanActorId } from "../src/collaboration-store.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import type { Env } from "../src/env.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "../src/collaboration-store.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.authorized),
  resolveUserId: vi.fn(async () => authState.userId),
}));

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
});

describe("read cursors and unread counts", () => {
  it("tracks unread counts from message seq minus read cursor", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    applyCollabV2Migrations(sqlite);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: authState.userId };
    const room = await createCollaborationRoom(env, scope, {
      roomId: "room_unread",
      title: "Unread",
      visibility: "private",
      createdAt: 1,
    });
    await env.AGENT_AUDIT.prepare(
      `UPDATE collaboration_rooms SET kind='channel', is_private=1 WHERE room_id=?`,
    ).bind(room.roomId).run();
    for (const seq of [1, 2, 3]) {
      await env.AGENT_AUDIT.prepare(
        `INSERT INTO collaboration_messages (message_id,tenant_id,workspace_id,room_id,sender_user_id,sender_actor_id,sender_kind,body,profile_version,created_at,message_seq)
         VALUES (?,?,?,?,?,?,'human',?,NULL,?,?)`,
      ).bind(`msg_${seq}`, scope.tenantId, scope.workspaceId, room.roomId, scope.userId, humanActorId(scope.userId), `m${seq}`, seq, seq).run();
    }
    const before = await handleCollaboration(
      new Request("https://worker.test/api/collaboration/rooms?kind=channel"),
      env,
    );
    const unread = await before!.json() as { rooms: Array<{ roomId: string; unreadCount: number }> };
    expect(unread.rooms.find((item) => item.roomId === room.roomId)?.unreadCount).toBe(3);
    await handleCollaboration(
      new Request("https://worker.test/api/collaboration/read-cursors", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "https://worker.test" },
        body: JSON.stringify({ roomId: room.roomId, lastReadSeq: 2 }),
      }),
      env,
    );
    const after = await handleCollaboration(
      new Request("https://worker.test/api/collaboration/rooms?kind=channel"),
      env,
    );
    const reduced = await after!.json() as { rooms: Array<{ unreadCount: number }> };
    expect(reduced.rooms[0]?.unreadCount).toBe(1);
  });
});