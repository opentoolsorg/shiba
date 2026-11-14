import { describe, expect, it } from "vitest";
import {
  addCollaborationMember,
  COLLAB_TENANT_ID,
  COLLAB_WORKSPACE_ID,
  createCollaborationRoom,
  createRootCollaborationHandoff,
  ensureCollaborationSchema,
} from "../src/collaboration-store.js";
import { attachHandoffReturn, cancelHandoffReturn } from "../src/collaboration-handoff-return.js";
import { postRoomEvent } from "../src/collaboration-thread-post.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = "owner@example.test";

async function linkedHandoff(handoffId: string) {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  await ensureCollaborationSchema(env);
  const scope = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, userId: OWNER };
  const room = await createCollaborationRoom(env, scope, { roomId: "room_return", title: "Return", visibility: "private", createdAt: 1 });
  for (const slug of ["parent", "child"]) {
    expect(await addCollaborationMember(env, scope, room.roomId, {
      userId: OWNER,
      displayName: slug,
      actorId: `agent:${slug}`,
      kind: "agent",
      profileVersion: 1,
      createdAt: 2,
    })).toBe(true);
  }
  const parent = await postRoomEvent(env, scope, { roomId: room.roomId, threadRootId: null, kind: "text", body: "Parent task", now: 3 });
  const child = await postRoomEvent(env, scope, { roomId: room.roomId, threadRootId: null, kind: "text", body: "Child task", now: 4 });
  const saved = await createRootCollaborationHandoff(env, scope, {
    handoffId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    roomId: room.roomId,
    taskId: "task_return",
    senderUserId: OWNER,
    senderActorId: "agent:parent",
    recipientUserId: OWNER,
    recipientActorId: "agent:child",
    parentHandoffId: null,
    rootHandoffId: handoffId,
    depth: 0,
    ancestorHandoffIds: [],
    remainingBudget: 4,
    grantedCapabilities: ["room.read", "message.send"],
    profileVersion: 1,
    status: "active",
    createdAt: 5,
    cancelledAt: null,
  });
  expect(saved).not.toBeNull();
  await attachHandoffReturn(env, scope, {
    handoffId,
    parentRoomId: room.roomId,
    parentThreadRootId: parent.messageId,
    parentActorId: "agent:parent",
    childRoomId: room.roomId,
    childThreadRootId: child.messageId,
    createdAt: 6,
  });
  return { env, sqlite, scope, roomId: room.roomId, parentId: parent.messageId, childId: child.messageId };
}

describe("handoff return", () => {
  it("posts exactly one handoff report when results arrive together", async () => {
    const { env, sqlite, scope, roomId, childId } = await linkedHandoff("handoff_report_once");
    const body = "x".repeat(400);
    await Promise.all([
      postRoomEvent(env, scope, { roomId, threadRootId: childId, kind: "result", body, payload: { runId: "run_child", pr: "12" }, now: 10 }),
      postRoomEvent(env, scope, { roomId, threadRootId: childId, kind: "result", body, payload: { runId: "run_child", pr: "12" }, now: 11 }),
    ]);
    const reports = sqlite.prepare("SELECT body, payload_json FROM collaboration_messages WHERE message_kind='handoff_report'").all() as { body: string; payload_json: string }[];
    expect(reports).toHaveLength(1);
    expect(reports[0]?.body.length).toBeLessThanOrEqual(280);
    const report = reports[0];
    if (!report) throw new Error("missing handoff report");
    const payload = JSON.parse(report.payload_json) as { handoffId: string; actorId: string; pr?: string };
    expect(payload.handoffId).toBe("handoff_report_once");
    expect(payload.actorId).toBe("agent:parent");
    expect(payload.pr).toBe("12");
    const status = sqlite.prepare("SELECT status FROM collaboration_handoff_returns").get() as { status: string };
    expect(status.status).toBe("reported");
  });

  it("posts one system line when the handoff is cancelled", async () => {
    const { env, sqlite, scope } = await linkedHandoff("handoff_cancel_once");
    expect(await cancelHandoffReturn(env, scope, "handoff_cancel_once", 20)).toBe(true);
    expect(await cancelHandoffReturn(env, scope, "handoff_cancel_once", 21)).toBe(false);
    const lines = sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_messages WHERE message_kind='system' AND body='Handoff cancelled.'").get() as { n: number };
    expect(lines.n).toBe(1);
    const status = sqlite.prepare("SELECT status FROM collaboration_handoff_returns").get() as { status: string };
    expect(status.status).toBe("cancelled");
  });
});
