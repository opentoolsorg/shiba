import { describe, expect, it } from "vitest";
import { agentMayReply } from "../src/collaboration-addressing.js";
import { createCollaborationRoom, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { postRoomEvent } from "../src/collaboration-thread-post.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "../src/collaboration-store.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { WorkspaceEvents } from "../src/platform/workspace-events-do.js";

describe("thread events", () => {
  it.each([
    ["private room", `room_${"ab".repeat(12)}`],
    ["private channel", `chn_${"cd".repeat(10)}`],
    ["dm", `dm_${"ef".repeat(10)}`],
  ])("delivers %s inserts and status edits only to current members", async (_kind, roomId) => {
    const { database, sqlite } = customAgentD1();
    const socket = (userId: string) => ({
      sent: [] as string[],
      deserializeAttachment: () => ({ userId }),
      send(value: string) { this.sent.push(value); },
    });
    const owner = socket("owner@example.test");
    const outsider = socket("outsider@example.test");
    const env = { AGENT_AUDIT: database } as unknown as Env;
    const hub = new WorkspaceEvents({ getWebSockets: () => [owner, outsider] } as never, env);
    const published: Array<{ audience: unknown; workspaceId: string }> = [];
    env.WorkspaceEvents = {
      getByName: () => ({ fetch: async (request: Request) => {
        published.push(await request.clone().json());
        const response = await hub.fetch(request);
        expect(response.status).toBe(200);
        return response;
      } }),
    } as unknown as Env["WorkspaceEvents"];
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: "owner@example.test" };
    await createCollaborationRoom(env, scope, { roomId, title: "Private", visibility: "private", createdAt: 1 });
    const root = await postRoomEvent(env, scope, { roomId, threadRootId: null, kind: "text", body: "Start" });
    const status = { roomId, threadRootId: root.messageId, kind: "status" as const, body: "Working" };
    await postRoomEvent(env, scope, status);
    await postRoomEvent(env, scope, { ...status, body: "Finished" });
    expect(owner.sent).toHaveLength(3);
    expect(outsider.sent).toEqual([]);
    expect(published).toHaveLength(3);
    for (const event of published) {
      expect(event.audience).toEqual({ roomId });
      expect(event.workspaceId).toBe(scope.workspaceId);
    }
    sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?")
      .run(roomId, scope.userId);
    await postRoomEvent(env, scope, { ...status, body: "Changed after removal" });
    expect(owner.sent).toHaveLength(3);
    expect(outsider.sent).toEqual([]);
  });

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
