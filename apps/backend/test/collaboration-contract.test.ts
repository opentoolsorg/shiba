import { describe, expect, it } from "vitest";
import {
  MAX_HANDOFF_BUDGET, MAX_HANDOFF_DEPTH, authorizeCollaborationAction,
  childHandoffLineage, validateCollaborationHandoff, validateCollaborationMessage,
} from "@shiba/shared";
import type { CollaborationActor, CollaborationHandoffEnvelope, CollaborationRoom } from "@shiba/shared";

const room: CollaborationRoom = { roomId: "room-1", tenantId: "tenant-1", workspaceId: "workspace-1", visibility: "private" };
const human: CollaborationActor = { kind: "human", actorId: "human-1", tenantId: "tenant-1", workspaceId: "workspace-1", userId: "user-1" };
const agent: CollaborationActor = { kind: "agent", actorId: "agent-1", tenantId: "tenant-1", workspaceId: "workspace-1", userId: "user-1" };
const context = (actor: CollaborationActor) => ({ tenantId: actor.tenantId, workspaceId: actor.workspaceId, userId: actor.userId, actor });
const membership = (actor: CollaborationActor, extra: Record<string, unknown> = {}) => ({
  roomId: room.roomId, tenantId: room.tenantId, workspaceId: room.workspaceId, userId: actor.userId,
  actorId: actor.actorId, actorKind: actor.kind, role: actor.kind === "agent" ? "agent" : "member",
  status: "active", capabilities: ["room.read", "message.send", "handoff.create", "task.cancel", "approval.decide"], ...extra,
});
const root: CollaborationHandoffEnvelope = {
  kind: "handoff", handoffId: "root", tenantId: room.tenantId, workspaceId: room.workspaceId, roomId: room.roomId,
  taskId: "task-1", sender: human, recipient: agent, createdAt: 100,
  lineage: { rootHandoffId: "root", parentHandoffId: null, depth: 0, ancestorHandoffIds: [] },
  remainingBudget: 5, grantedCapabilities: ["room.read", "message.send", "handoff.create", "task.cancel"], profileVersion: 7,
};

describe("collaboration authorization contracts", () => {
  it("requires explicit active membership for private and shared rooms", () => {
    for (const visibility of ["private", "shared"] as const) {
      const scopedRoom = { ...room, visibility };
      expect(authorizeCollaborationAction(context(human), scopedRoom, membership(human) as never, "room.read").allowed).toBe(true);
      expect(authorizeCollaborationAction(context(human), scopedRoom, undefined, "room.read")).toEqual({ allowed: false, reason: "not-a-member" });
      expect(authorizeCollaborationAction(context(human), scopedRoom, membership(human, { status: "removed" }) as never, "room.read")).toEqual({ allowed: false, reason: "membership-removed" });
    }
  });

  it("blocks agent approvals, unknown actors, wrong memberships, and missing capabilities", () => {
    expect(authorizeCollaborationAction(context(agent), room, membership(agent) as never, "approval.decide")).toEqual({ allowed: false, reason: "agent-cannot-approve" });
    expect(authorizeCollaborationAction({ ...context(human), actor: { ...human, kind: "service" } as never }, room, membership(human) as never, "approval.decide")).toEqual({ allowed: false, reason: "invalid-context" });
    expect(authorizeCollaborationAction(context(human), room, membership(human, { capabilities: ["room.read"] }) as never, "message.send")).toEqual({ allowed: false, reason: "capability-missing" });
    expect(authorizeCollaborationAction(context(human), room, membership(human, { role: "agent" }) as never, "room.read")).toEqual({ allowed: false, reason: "actor-mismatch" });
  });

  it("validates message scope, sender, body, time and agent profile version", () => {
    const message = { kind: "message", messageId: "m1", tenantId: room.tenantId, workspaceId: room.workspaceId, roomId: room.roomId, sender: agent, body: "Working", createdAt: 100, profileVersion: 7 };
    expect(validateCollaborationMessage(message, room)).toEqual({ valid: true });
    expect(validateCollaborationMessage({ ...message, profileVersion: undefined }, room)).toEqual({ valid: false, reason: "invalid-profile-version" });
    expect(validateCollaborationMessage({ ...message, body: "" }, room)).toEqual({ valid: false, reason: "invalid-identity" });
    expect(validateCollaborationMessage({ ...message, createdAt: Number.NaN }, room)).toEqual({ valid: false, reason: "invalid-time" });
    expect(validateCollaborationMessage(Object.create(message), room)).toEqual({ valid: false, reason: "invalid-envelope" });
  });

  it("requires child sender continuity, strict budget propagation, and bounded lineage", () => {
    expect(validateCollaborationHandoff(root, { expected: room, senderCapabilities: root.grantedCapabilities })).toEqual({ valid: true });
    const child: CollaborationHandoffEnvelope = {
      ...root, handoffId: "child", sender: agent, recipient: { ...agent, actorId: "agent-2", userId: "user-2" },
      lineage: childHandoffLineage(root)!, remainingBudget: 2, grantedCapabilities: ["room.read", "message.send"],
    };
    const options = { expected: room, parent: root, senderCapabilities: root.grantedCapabilities };
    expect(validateCollaborationHandoff(child, options)).toEqual({ valid: true });
    expect(validateCollaborationHandoff({ ...child, sender: human }, options)).toEqual({ valid: false, reason: "parent-mismatch" });
    expect(validateCollaborationHandoff({ ...child, remainingBudget: root.remainingBudget }, options)).toEqual({ valid: false, reason: "invalid-budget-propagation" });
    expect(validateCollaborationHandoff({ ...root, remainingBudget: MAX_HANDOFF_BUDGET + 1 }, { expected: room, senderCapabilities: root.grantedCapabilities })).toEqual({ valid: false, reason: "budget-exceeded" });
    expect(validateCollaborationHandoff({ ...child, lineage: { ...child.lineage, depth: MAX_HANDOFF_DEPTH + 1, ancestorHandoffIds: ["a", "b", "c", "d", "e"] } }, options)).toEqual({ valid: false, reason: "depth-exceeded" });
    expect(validateCollaborationHandoff({ ...child, lineage: { ...child.lineage, ancestorHandoffIds: ["forged"] } }, options)).toEqual({ valid: false, reason: "parent-mismatch" });
    expect(validateCollaborationHandoff({ ...child, lineage: childHandoffLineage(root), remainingBudget: 3 }, { ...options, parent: { ...root, remainingBudget: Number.NaN } })).toEqual({ valid: false, reason: "budget-exceeded" });
  });
});
