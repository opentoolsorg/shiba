import { describe, expect, it } from "vitest";
import { addCollaborationMember, COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, createCollaborationRoom, ensureCollaborationSchema } from "../src/collaboration-store.js";
import { coordinateHumanMessage } from "../src/collaboration-router.js";
import type { Env } from "../src/env.js";
import { applyCollabV2Migrations } from "./fixtures/collab-v2-migrations.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = "owner@example.test";

async function room() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await ensureCollaborationSchema(env);
  applyCollabV2Migrations(sqlite);
  const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: OWNER };
  const created = await createCollaborationRoom(env, scope, { roomId: "room_claims", title: "Claims", visibility: "private", createdAt: 1 });
  for (const slug of ["alpha", "beta"]) {
    expect(await addCollaborationMember(env, scope, created.roomId, {
      userId: OWNER,
      displayName: slug,
      actorId: `agent:${slug}`,
      kind: "agent",
      profileVersion: 1,
      createdAt: 2,
    })).toBe(true);
  }
  return { env, sqlite, scope, roomId: created.roomId };
}

describe("reply claims", () => {
  it("lets two listen-mode agents produce one ack", async () => {
    const { env, sqlite, scope, roomId } = await room();
    for (const slug of ["alpha", "beta"]) {
      sqlite.prepare(
        `INSERT INTO collaboration_agent_listen_mode (tenant_id, workspace_id, room_id, actor_id, mode, updated_at)
         VALUES (?, ?, ?, ?, 'all', 1)`,
      ).run(scope.tenantId, scope.workspaceId, roomId, `agent:${slug}`);
    }
    const first = await coordinateHumanMessage(env, scope, { roomId, messageId: "msg_listen", body: "anyone around", now: 10 });
    expect(first.startedRun).toBe(false);
    const acks = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_messages WHERE message_kind='ack'").get() as { n: number }).n;
    expect(acks()).toBe(1);
  });

  it("lets two explicit mentions produce two acks", async () => {
    const { env, sqlite, scope, roomId } = await room();
    const result = await coordinateHumanMessage(env, scope, {
      roomId,
      messageId: "msg_mentions",
      body: "@agent:alpha @agent:beta look at this",
      now: 20,
    });
    expect(result.handoffs).toHaveLength(2);
    expect(result.startedRun).toBe(false);
    const acks = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_messages WHERE message_kind='ack'").get() as { n: number };
    expect(acks.n).toBe(2);
    const runs = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_handoffs WHERE run_id IS NOT NULL").get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it("does not ack again when the same Slack event is replayed", async () => {
    const { env, sqlite, scope, roomId } = await room();
    for (const slug of ["alpha", "beta"]) {
      sqlite.prepare(
        `INSERT INTO collaboration_agent_listen_mode (tenant_id, workspace_id, room_id, actor_id, mode, updated_at)
         VALUES (?, ?, ?, ?, 'all', 1)`,
      ).run(scope.tenantId, scope.workspaceId, roomId, `agent:${slug}`);
    }
    await coordinateHumanMessage(env, scope, {
      roomId,
      messageId: "msg_slack_1",
      body: "anyone around",
      sourceSlackEventId: "slack-evt-1",
      now: 30,
    });
    await coordinateHumanMessage(env, scope, {
      roomId,
      messageId: "msg_slack_2",
      body: "anyone around",
      sourceSlackEventId: "slack-evt-1",
      now: 31,
    });
    const acks = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_messages WHERE message_kind='ack'").get() as { n: number };
    expect(acks.n).toBe(1);
  });
});
