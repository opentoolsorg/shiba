import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCollaborationMember,
  createCollaborationRoom,
  ensureCollaborationSchema,
} from "../src/collaboration-store.js";
import { createChannel } from "../src/collaboration-v2-store.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { handleNotifications } from "../src/notifications/notifications-routes.js";
import { parseCollaborationMentions } from "../src/collaboration-mentions.js";
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

describe("mentions and notifications", () => {
  it("parses user and agent mentions", () => {
    const parsed = parseCollaborationMentions("hi @user:peer@example.test and @agent:planner_bot");
    expect(parsed.users).toEqual(["peer@example.test"]);
    expect(parsed.agents).toEqual(["planner_bot"]);
  });

  it("creates mention notifications and agent mention handoffs in channels", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database } as unknown as Env;
    await ensureCollaborationSchema(env);
    applyCollabV2Migrations(sqlite);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: authState.userId };
    const channel = await createChannel(env, scope, { roomId: "chn_mentions", title: "Mentions", createdAt: 1 });
    await addCollaborationMember(env, scope, channel.roomId, {
      userId: "peer@example.test",
      displayName: "peer",
      actorId: "human:peer@example.test",
      kind: "human",
      createdAt: 1,
    });
    await addCollaborationMember(env, scope, channel.roomId, {
      userId: scope.userId,
      displayName: "Planner",
      actorId: "agent:planner_bot",
      kind: "agent",
      profileVersion: 1,
      createdAt: 1,
    });
    const post = await handleCollaboration(
      new Request(`https://worker.test/api/collaboration/rooms/${channel.roomId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://worker.test" },
        body: JSON.stringify({ body: "Please review @user:peer@example.test and @agent:planner_bot" }),
      }),
      env,
    );
    expect(post?.status).toBe(201);
    authState.userId = "peer@example.test";
    const listed = await handleNotifications(
      new Request("https://worker.test/api/workspace-notifications"),
      env,
    );
    const body = await listed!.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.filter((item) => item.kind === "mention")).toHaveLength(1);
    expect(body.notifications.some((item) => item.kind === "needs_you")).toBe(false);
    const handoffCount = sqlite.prepare("SELECT COUNT(*) AS count FROM collaboration_handoffs").get() as { count: number };
    expect(handoffCount.count).toBe(1);
  });
});