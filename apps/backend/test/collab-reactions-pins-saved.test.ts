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

async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await ensureCollaborationSchema(env);
  applyCollabV2Migrations(sqlite);
  const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: authState.userId };
  const room = await createCollaborationRoom(env, scope, {
    roomId: "room_reactions",
    title: "Reactions",
    visibility: "private",
    createdAt: 1,
  });
  const send = (path: string, method = "GET", body?: unknown) => handleCollaboration(
    new Request(`https://worker.test/api/collaboration${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(method === "GET" ? {} : { origin: "https://worker.test" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
  const messageId = "msg_reaction_1";
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_messages (message_id,tenant_id,workspace_id,room_id,sender_user_id,sender_actor_id,sender_kind,body,profile_version,created_at,message_seq)
     VALUES (?,?,?,?,?,?,'human','hello',NULL,?,1)`,
  ).bind(messageId, scope.tenantId, scope.workspaceId, room.roomId, scope.userId, humanActorId(scope.userId), 2).run();
  return { send, roomId: room.roomId, messageId, sqlite };
}

beforeEach(() => {
  authState.userId = "owner@example.test";
  authState.authorized = true;
});

describe("collab v2 reactions pins saved follows", () => {
  it("toggles reactions and tracks pins, saved items, and thread follows", async () => {
    const f = await fixture();
    const added = await (await f.send("/reactions", "POST", { roomId: f.roomId, messageId: f.messageId, emoji: "✅" }))!.json() as { added: boolean };
    expect(added.added).toBe(true);
  const removed = await (await f.send("/reactions", "DELETE", { roomId: f.roomId, messageId: f.messageId, emoji: "✅" }))!.json() as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect((await f.send("/pins", "POST", { roomId: f.roomId, messageId: f.messageId }))?.status).toBe(201);
    expect((await f.send("/saved", "POST", { roomId: f.roomId, messageId: f.messageId }))?.status).toBe(201);
    const saved = await (await f.send("/saved"))!.json() as { saved: Array<{ messageId: string }> };
    expect(saved.saved[0]?.messageId).toBe(f.messageId);
    expect((await f.send("/follows", "POST", { roomId: f.roomId, threadRootMessageId: f.messageId }))?.status).toBe(201);
    const followCount = f.sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_thread_follows").get() as { count: number };
    expect(followCount.count).toBe(1);
  });
});