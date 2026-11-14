import { describe, expect, it } from "vitest";
import { addCollaborationMember, COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, createCollaborationRoom, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { handleCollaborationMentions } from "../src/collaboration-mentions.js";
import { createWorkspaceNotification, listWorkspaceNotifications } from "../src/notifications/notifications-store.js";
import type { Env } from "../src/env.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("needs-you dedupe", () => {
  it("keeps one row per user and message, preferring the mention", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    applyCollabV2Migrations(sqlite);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: "owner@example.test" };
    await createWorkspaceNotification(env, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      userId: "peer@example.test",
      kind: "needs_you",
      title: "Needs you",
      body: "same message",
      roomId: "room_dedupe",
      messageId: "msg_same",
      createdAt: 1,
    });
    await createWorkspaceNotification(env, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      userId: "peer@example.test",
      kind: "mention",
      title: "You were mentioned",
      body: "same message",
      roomId: "room_dedupe",
      messageId: "msg_same",
      createdAt: 2,
    });
    const listed = await listWorkspaceNotifications(env, { ...scope, userId: "peer@example.test" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.kind).toBe("mention");

    const room = await createCollaborationRoom(env, scope, { roomId: "room_mentions", title: "Mentions", visibility: "private", createdAt: 3 });
    expect(await addCollaborationMember(env, scope, room.roomId, {
      userId: "peer@example.test",
      displayName: "peer",
      actorId: "human:peer@example.test",
      kind: "human",
      createdAt: 4,
    })).toBe(true);
    await handleCollaborationMentions(env, scope, {
      roomId: room.roomId,
      messageId: "msg_fresh",
      body: "hello @user:peer@example.test",
      now: 5,
    });
    const fresh = await listWorkspaceNotifications(env, { ...scope, userId: "peer@example.test" });
    const forMessage = fresh.filter((row) => row.messageId === "msg_fresh");
    expect(forMessage.map((row) => row.kind)).toEqual(["mention"]);
  });
});
