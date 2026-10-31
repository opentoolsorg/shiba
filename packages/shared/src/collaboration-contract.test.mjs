import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCollaborationAction,
  childHandoffLineage,
  MAX_HANDOFF_BUDGET,
  MAX_HANDOFF_DEPTH,
  validateCollaborationHandoff,
  validateCollaborationMessage,
  validateHandoffCancellation,
} from "./collaboration-contract.ts";

const room = {
  roomId: "room-1",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  visibility: "private",
};
const human = {
  kind: "human",
  actorId: "human-1",
  tenantId: room.tenantId,
  workspaceId: room.workspaceId,
  userId: "user-1",
};
const agent = {
  kind: "agent",
  actorId: "agent-1",
  tenantId: room.tenantId,
  workspaceId: room.workspaceId,
  userId: "user-1",
};
const context = (actor = human) => ({
  tenantId: actor.tenantId,
  workspaceId: actor.workspaceId,
  userId: actor.userId,
  actor,
});
const membership = (actor, overrides = {}) => ({
  roomId: room.roomId,
  tenantId: room.tenantId,
  workspaceId: room.workspaceId,
  userId: actor.userId,
  actorId: actor.actorId,
  actorKind: actor.kind,
  role: actor.kind === "human" ? "member" : "agent",
  status: "active",
  capabilities: ["room.read", "message.send", "handoff.create", "task.cancel", "approval.decide"],
  ...overrides,
});
const rootHandoff = (overrides = {}) => ({
  kind: "handoff",
  handoffId: "handoff-root",
  tenantId: room.tenantId,
  workspaceId: room.workspaceId,
  roomId: room.roomId,
  taskId: "task-1",
  sender: human,
  recipient: agent,
  createdAt: 100,
  lineage: {
    rootHandoffId: "handoff-root",
    parentHandoffId: null,
    depth: 0,
    ancestorHandoffIds: [],
  },
  remainingBudget: 5,
  grantedCapabilities: ["room.read", "message.send", "handoff.create", "task.cancel"],
  profileVersion: 7,
  ...overrides,
});

test("private and shared rooms both require active, scoped membership", () => {
  for (const visibility of ["private", "shared"]) {
    const scopedRoom = { ...room, visibility };
    assert.deepEqual(
      authorizeCollaborationAction(context(), scopedRoom, membership(human), "room.read"),
      { allowed: true, reason: "authorized" },
    );
    assert.deepEqual(authorizeCollaborationAction(context(), scopedRoom, undefined, "room.read"), {
      allowed: false,
      reason: "not-a-member",
    });
    assert.deepEqual(
      authorizeCollaborationAction(
        context(),
        scopedRoom,
        membership(human, { status: "removed" }),
        "room.read",
      ),
      { allowed: false, reason: "membership-removed" },
    );
  }
  assert.deepEqual(
    authorizeCollaborationAction(
      { ...context(), tenantId: "other" },
      room,
      membership(human),
      "room.read",
    ),
    { allowed: false, reason: "scope-mismatch" },
  );
});

test("authorization permits agent messages but never agent approvals or widened roles", () => {
  assert.equal(
    authorizeCollaborationAction(context(agent), room, membership(agent), "message.send").allowed,
    true,
  );
  assert.deepEqual(
    authorizeCollaborationAction(context(agent), room, membership(agent), "approval.decide"),
    { allowed: false, reason: "agent-cannot-approve" },
  );
  assert.deepEqual(
    authorizeCollaborationAction(
      context(agent),
      room,
      membership(agent, { role: "member" }),
      "message.send",
    ),
    { allowed: false, reason: "actor-mismatch" },
  );
});

test("message validation rejects malformed bodies, scopes, and missing profile versions", () => {
  const valid = {
    kind: "message",
    messageId: "message-1",
    tenantId: room.tenantId,
    workspaceId: room.workspaceId,
    roomId: room.roomId,
    sender: agent,
    body: "Working on it",
    createdAt: 100,
    profileVersion: 7,
  };
  assert.deepEqual(validateCollaborationMessage(valid, room), { valid: true });
  assert.deepEqual(validateCollaborationMessage({ ...valid, body: "" }, room), {
    valid: false,
    reason: "invalid-identity",
  });
  assert.deepEqual(validateCollaborationMessage({ ...valid, roomId: "other" }, room), {
    valid: false,
    reason: "invalid-scope",
  });
  assert.deepEqual(validateCollaborationMessage({ ...valid, profileVersion: undefined }, room), {
    valid: false,
    reason: "invalid-profile-version",
  });
});

test("handoffs enforce lineage, depth, aggregate budget, replay, authority, and profile pinning", () => {
  const root = rootHandoff();
  const senderCapabilities = ["room.read", "message.send", "handoff.create", "task.cancel"];
  assert.deepEqual(
    validateCollaborationHandoff(root, {
      expected: room,
      senderCapabilities,
      recipientProfileVersion: 7,
    }),
    { valid: true },
  );
  const child = {
    ...root,
    handoffId: "handoff-child",
    sender: agent,
    recipient: { ...agent, actorId: "agent-2", userId: "user-2" },
    lineage: childHandoffLineage(root),
    remainingBudget: 2,
    grantedCapabilities: ["room.read", "message.send"],
  };
  const options = {
    expected: room,
    parent: root,
    senderCapabilities: root.grantedCapabilities,
    recipientProfileVersion: 7,
    senderProfileVersion: 7,
  };
  assert.deepEqual(validateCollaborationHandoff(child, options), { valid: true });
  assert.deepEqual(
    validateCollaborationHandoff(child, { ...options, seenHandoffIds: new Set([child.handoffId]) }),
    { valid: false, reason: "duplicate-handoff-id" },
  );
  assert.deepEqual(
    validateCollaborationHandoff({ ...child, grantedCapabilities: ["approval.decide"] }, options),
    { valid: false, reason: "authority-widened" },
  );
  assert.deepEqual(validateCollaborationHandoff({ ...child, profileVersion: 8 }, options), {
    valid: false,
    reason: "profile-version-mismatch",
  });
  assert.deepEqual(
    validateCollaborationHandoff({ ...child, remainingBudget: root.remainingBudget }, options),
    { valid: false, reason: "invalid-budget-propagation" },
  );
  assert.deepEqual(
    validateCollaborationHandoff({ ...child, remainingBudget: MAX_HANDOFF_BUDGET + 1 }, options),
    { valid: false, reason: "budget-exceeded" },
  );
  assert.deepEqual(
    validateCollaborationHandoff(
      {
        ...child,
        lineage: {
          ...child.lineage,
          depth: MAX_HANDOFF_DEPTH + 1,
          ancestorHandoffIds: ["a", "b", "c", "d", "e"],
        },
      },
      options,
    ),
    { valid: false, reason: "depth-exceeded" },
  );
  assert.deepEqual(
    validateCollaborationHandoff(
      { ...child, lineage: { ...child.lineage, ancestorHandoffIds: ["forged"] } },
      options,
    ),
    { valid: false, reason: "parent-mismatch" },
  );
});

test("cancellation is valid only for the exact room, task, and lineage target", () => {
  const root = rootHandoff();
  const child = { ...root, handoffId: "handoff-child", lineage: childHandoffLineage(root) };
  const cancellation = {
    tenantId: room.tenantId,
    workspaceId: room.workspaceId,
    roomId: room.roomId,
    taskId: "task-1",
    targetHandoffId: child.handoffId,
    rootHandoffId: root.handoffId,
    ancestorHandoffIds: [root.handoffId],
  };
  assert.deepEqual(validateHandoffCancellation(cancellation, child), { valid: true });
  assert.deepEqual(validateHandoffCancellation({ ...cancellation, taskId: "other" }, child), {
    valid: false,
    reason: "invalid-scope",
  });
  assert.deepEqual(
    validateHandoffCancellation({ ...cancellation, ancestorHandoffIds: [] }, child),
    { valid: false, reason: "invalid-lineage" },
  );
});
