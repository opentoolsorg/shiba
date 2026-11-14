import { describe, expect, it } from "vitest";
import { agentMayReply } from "../src/collaboration-addressing.js";
import { createCollaborationRoom, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { postRoomEvent } from "../src/collaboration-thread-post.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("thread events", () => {
  it("upserts a single status row per thread", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: "owner@example.test" };
    const room = await createCollaborationRoom(env, scope, {
      roomId: "room_status",
      title: "Status",
      visibility: "private",
      createdAt: 1,
    });
    const root = await postRoomEvent(env, scope, {
      roomId: room.roomId,
      threadRootId: null,
      kind: "text",
      body: "Fix the typo",
      now: 10,
    });
    const first = await postRoomEvent(env, scope, {
      roomId: room.roomId,
      threadRootId: root.messageId,
      kind: "status",
      body: "Working · reading files",
      payload: { runId: "run_1" },
      editKey: "status",
      now: 20,
    });
    const second = await postRoomEvent(env, scope, {
      roomId: room.roomId,
      threadRootId: root.messageId,
      kind: "status",
      body: "Working · editing 3 files",
      payload: { runId: "run_1" },
      editKey: "status",
      now: 30,
    });
    expect(second.messageId).toBe(first.messageId);
    expect(second.edited).toBe(true);
    expect(second.version).toBe(2);
    const count = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_messages WHERE message_kind='status'",
    ).get() as { count: number };
    expect(count.count).toBe(1);
    const rootRow = sqlite.prepare(
      "SELECT reply_count AS replies FROM collaboration_messages WHERE message_id=?",
    ).get(root.messageId) as { replies: number };
    expect(rootRow.replies).toBeGreaterThan(0);
  });

  it("does not let an agent reply in a channel unless it was addressed", () => {
    expect(agentMayReply({
      mentioned: false,
      ownsThread: false,
      soleAgentInDm: false,
      receivedHandoff: false,
      listenMode: "mentions",
    })).toBe(false);
    expect(agentMayReply({
      mentioned: false,
      ownsThread: true,
      soleAgentInDm: false,
      receivedHandoff: false,
      listenMode: "mentions",
    })).toBe(true);
  });
});