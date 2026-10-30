import {
  authorizeCollaborationAction,
  type CollaborationActor,
  type CollaborationHandoffEnvelope,
  type CollaborationMembership,
  type CollaborationRoom,
  childHandoffLineage,
  MAX_HANDOFF_BUDGET,
  validateCollaborationHandoff,
  validateCollaborationMessage,
  validateHandoffCancellation,
} from "../../../packages/shared/src/collaboration-contract.js";
import {
  addCollaborationMember,
  COLLAB_TENANT_ID,
  COLLAB_WORKSPACE_ID,
  type CollaborationHandoffRow,
  type CollaborationScope,
  CollaborationStoreError,
  cancelCollaborationHandoff,
  createChildCollaborationHandoff,
  createCollaborationMessage,
  createCollaborationRoom,
  createRootCollaborationHandoff,
  getActiveCollaborationMembership,
  getCollaborationHandoff,
  getCollaborationMembership,
  getCollaborationRoom,
  humanActorId,
  listCollaborationHandoffs,
  listCollaborationMemberships,
  listCollaborationMessages,
  listCollaborationRooms,
  removeCollaborationMember,
} from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";

const PREFIX = "/api/collaboration";
const BODY_LIMIT = 16 * 1024;
const MAX_MESSAGE_LENGTH = 5_000;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    throw new CollaborationStoreError("Request body is too large.", 413);
  }
  if (!request.body) throw new CollaborationStoreError("Request body is required.");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(BODY_LIMIT);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.length > BODY_LIMIT)
        throw new CollaborationStoreError("Request body is too large.", 413);
      bytes.set(part.value, used);
      used += part.value.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, used)));
    } catch {
      throw new CollaborationStoreError("Request body must be a JSON object.");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CollaborationStoreError("Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function scopeFor(userId: string): CollaborationScope {
  return {
    tenantId: COLLAB_TENANT_ID,
    workspaceId: COLLAB_WORKSPACE_ID,
    userId: userId.trim().toLowerCase(),
  };
}

function actorFor(
  scope: CollaborationScope,
  kind: "human" | "agent",
  actorId: string,
): CollaborationActor {
  return {
    kind,
    actorId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  };
}

function roomFor(row: {
  roomId: string;
  tenantId: string;
  workspaceId: string;
  visibility: "private" | "shared";
}): CollaborationRoom {
  return {
    roomId: row.roomId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    visibility: row.visibility,
  };
}

function membershipFor(
  row: Awaited<ReturnType<typeof getCollaborationMembership>>,
): CollaborationMembership | undefined {
  if (row?.status !== "active") return undefined;
  return {
    roomId: row.roomId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    actorId: row.actorId,
    actorKind: row.actorKind,
    role: row.role,
    status: row.status,
    capabilities: row.capabilities,
  };
}

async function authorizeRoomAction(
  env: Env,
  scope: CollaborationScope,
  roomId: string,
  actorId: string,
  action:
    | "room.read"
    | "message.send"
    | "handoff.create"
    | "task.cancel"
    | "approval.decide"
    | "membership.manage",
) {
  const room = await getCollaborationRoom(env, scope, roomId);
  if (!room) return { response: json({ error: "Room not found." }, 404) } as const;
  const memberRow = await getCollaborationMembership(env, scope, roomId, actorId);
  const actor = memberRow
    ? actorFor(scope, memberRow.actorKind, memberRow.actorId)
    : actorFor(scope, "human", actorId);
  const result = authorizeCollaborationAction(
    { ...scope, actor },
    roomFor(room),
    membershipFor(memberRow),
    action,
  );
  if (!result.allowed)
    return { response: json({ error: "Forbidden.", reason: result.reason }, 403) } as const;
  if (!memberRow) return { response: json({ error: "Forbidden." }, 403) } as const;
  return { room, membership: memberRow } as const;
}

function envelopeForHandoff(row: CollaborationHandoffRow): CollaborationHandoffEnvelope {
  return {
    kind: "handoff",
    handoffId: row.handoffId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    roomId: row.roomId,
    taskId: row.taskId,
    sender: {
      kind: row.senderActorId.startsWith("agent:") ? "agent" : "human",
      actorId: row.senderActorId,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      userId: row.senderUserId,
    },
    recipient: {
      kind: row.recipientActorId.startsWith("agent:") ? "agent" : "human",
      actorId: row.recipientActorId,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      userId: row.recipientUserId,
    },
    createdAt: row.createdAt,
    lineage: {
      rootHandoffId: row.rootHandoffId,
      parentHandoffId: row.parentHandoffId,
      depth: row.depth,
      ancestorHandoffIds: row.ancestorHandoffIds,
    },
    remainingBudget: row.remainingBudget,
    grantedCapabilities: row.grantedCapabilities,
    ...(row.profileVersion !== null ? { profileVersion: row.profileVersion } : {}),
  };
}

function invalidBody(message: string): Response {
  return json({ error: message }, 400);
}

/** Internal Shiba task rooms. Identity and workspace scope are derived server-side. */
export async function handleCollaboration(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!(await isAuthorizedRequest(request, env)))
    return json({ error: "Authentication required." }, 401);
  const resolvedUserId = await resolveUserId(request, env);
  if (!resolvedUserId?.trim()) return json({ error: "Authenticated user required." }, 401);
  if (!env.AGENT_AUDIT) return json({ error: "Collaboration storage is unavailable." }, 503);
  const scope = scopeFor(resolvedUserId);
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    (request.headers.get("origin") !== url.origin ||
      request.headers.get("sec-fetch-site") === "cross-site")
  ) {
    return json({ error: "Same-origin request required." }, 403);
  }
  const path = url.pathname
    .slice(PREFIX.length)
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  if (path.some((part) => !part)) return invalidBody("Invalid path.");

  try {
    if (path.length === 1 && path[0] === "rooms" && request.method === "GET") {
      return json({ rooms: await listCollaborationRooms(env, scope) });
    }
    if (path.length === 1 && path[0] === "rooms" && request.method === "POST") {
      const body = await bodyObject(request);
      if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120)
        return invalidBody("Room title must be 1–120 characters.");
      const visibility = body.visibility === undefined ? "private" : body.visibility;
      if (visibility !== "private" && visibility !== "shared")
        return invalidBody("Room visibility must be private or shared.");
      const room = await createCollaborationRoom(env, scope, {
        roomId: `room_${randomHex(12)}`,
        title: body.title.trim(),
        visibility,
        createdAt: Date.now(),
      });
      return json({ room }, 201);
    }

    if (path[0] === "rooms" && path.length === 2 && request.method === "GET") {
      const roomId = path[1] ?? "";
      const access = await authorizeRoomAction(
        env,
        scope,
        roomId,
        humanActorId(scope.userId),
        "room.read",
      );
      if ("response" in access && access.response) return access.response;
      const [members, messages, handoffs] = await Promise.all([
        listCollaborationMemberships(env, scope, roomId),
        listCollaborationMessages(env, scope, roomId),
        listCollaborationHandoffs(env, scope, roomId),
      ]);
      return json({ room: access.room, currentUserId: scope.userId, members, messages, handoffs });
    }

    if (
      path[0] === "rooms" &&
      path.length === 3 &&
      path[2] === "members" &&
      request.method === "POST"
    ) {
      const roomId = path[1] ?? "";
      const access = await authorizeRoomAction(
        env,
        scope,
        roomId,
        humanActorId(scope.userId),
        "membership.manage",
      );
      if ("response" in access && access.response) return access.response;
      if (access.membership.role !== "owner")
        return json({ error: "Only room owners can invite members." }, 403);
      const body = await bodyObject(request);
      if (body.kind !== undefined && body.kind !== "human")
        return invalidBody("Use /agents to add an agent participant.");
      if (typeof body.userId !== "string" || !body.userId.trim() || body.userId.length > 320)
        return invalidBody("Member userId is required.");
      const userId = body.userId.trim().toLowerCase();
      const actorId = humanActorId(userId);
      const inserted = await addCollaborationMember(env, scope, roomId, {
        userId,
        displayName: userId,
        actorId,
        kind: "human",
        createdAt: Date.now(),
      });
      if (!inserted) return json({ error: "Member could not be added." }, 409);
      const member = await getCollaborationMembership(env, scopeFor(userId), roomId, actorId);
      return json({ member }, 201);
    }

    if (
      path[0] === "rooms" &&
      path.length === 3 &&
      path[2] === "agents" &&
      request.method === "POST"
    ) {
      const roomId = path[1] ?? "";
      const access = await authorizeRoomAction(
        env,
        scope,
        roomId,
        humanActorId(scope.userId),
        "membership.manage",
      );
      if ("response" in access && access.response) return access.response;
      if (access.membership.role !== "owner")
        return json({ error: "Only room owners can add an agent participant." }, 403);
      const body = await bodyObject(request);
      const actorId = `agent:${randomHex(12)}`;
      const displayName =
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim().slice(0, 80)
          : "Agent";
      const inserted = await addCollaborationMember(env, scope, roomId, {
        userId: scope.userId,
        displayName,
        actorId,
        kind: "agent",
        createdAt: Date.now(),
      });
      if (!inserted) return json({ error: "Agent participant could not be added." }, 409);
      const member = await getCollaborationMembership(env, scope, roomId, actorId);
      return json({ member }, 201);
    }

    if (
      path[0] === "rooms" &&
      path.length === 4 &&
      path[2] === "members" &&
      request.method === "DELETE"
    ) {
      const roomId = path[1] ?? "";
      const access = await authorizeRoomAction(
        env,
        scope,
        roomId,
        humanActorId(scope.userId),
        "membership.manage",
      );
      if ("response" in access && access.response) return access.response;
      if (access.membership.role !== "owner")
        return json({ error: "Only room owners can remove members." }, 403);
      const changed = await removeCollaborationMember(
        env,
        scope,
        roomId,
        path[3] ?? "",
        Date.now(),
      );
      return changed
        ? json({ removed: true })
        : json({ error: "Member not found or cannot be removed." }, 404);
    }

    if (
      path[0] === "rooms" &&
      path.length === 3 &&
      path[2] === "messages" &&
      request.method === "POST"
    ) {
      const roomId = path[1] ?? "";
      const body = await bodyObject(request);
      const actorId = humanActorId(scope.userId);
      if (body.actorId !== undefined && body.actorId !== actorId) {
        return json({ error: "Agent identities are not callable from a human session." }, 403);
      }
      const access = await authorizeRoomAction(env, scope, roomId, actorId, "message.send");
      if ("response" in access && access.response) return access.response;
      if (
        typeof body.body !== "string" ||
        !body.body.trim() ||
        body.body.length > MAX_MESSAGE_LENGTH
      )
        return invalidBody(`Message must be 1–${MAX_MESSAGE_LENGTH} characters.`);
      const sender = actorFor(scope, access.membership.actorKind, access.membership.actorId);
      const message = {
        kind: "message" as const,
        messageId:
          typeof body.messageId === "string" && body.messageId.length <= 100
            ? body.messageId
            : `msg_${randomHex(12)}`,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        roomId,
        sender,
        body: body.body.trim(),
        createdAt: Date.now(),
        ...(access.membership.profileVersion !== null
          ? { profileVersion: access.membership.profileVersion }
          : {}),
      };
      const valid = validateCollaborationMessage(message, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        roomId,
      });
      if (!valid.valid) return invalidBody("Invalid message envelope.");
      const authorization = authorizeCollaborationAction(
        { ...scope, actor: sender },
        roomFor(access.room),
        membershipFor(access.membership),
        "message.send",
      );
      if (!authorization.allowed) return json({ error: "Forbidden." }, 403);
      const saved = await createCollaborationMessage(env, scope, {
        messageId: message.messageId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        roomId,
        senderUserId: scope.userId,
        senderActorId: sender.actorId,
        senderKind: sender.kind,
        body: message.body,
        profileVersion: message.profileVersion ?? null,
        createdAt: message.createdAt,
      });
      if (!saved) return json({ error: "Membership was removed." }, 403);
      return json({ message: saved }, 201);
    }

    if (
      path[0] === "rooms" &&
      path.length === 3 &&
      path[2] === "handoffs" &&
      request.method === "POST"
    ) {
      const roomId = path[1] ?? "";
      const body = await bodyObject(request);
      const actorId = humanActorId(scope.userId);
      if (body.actorId !== undefined && body.actorId !== actorId) {
        return json({ error: "Agent identities are not callable from a human session." }, 403);
      }
      const access = await authorizeRoomAction(env, scope, roomId, actorId, "handoff.create");
      if ("response" in access && access.response) return access.response;
      if (typeof body.handoffId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.handoffId))
        return invalidBody("A unique handoffId is required.");
      if (typeof body.taskId !== "string" || !body.taskId.trim() || body.taskId.length > 120)
        return invalidBody("Task id is required.");
      if (typeof body.recipientActorId !== "string")
        return invalidBody("Recipient actor is required.");
      const recipient = await getActiveCollaborationMembership(
        env,
        scope,
        roomId,
        body.recipientActorId,
      );
      if (!recipient) return json({ error: "Recipient is not an active room member." }, 404);
      if (recipient.actorId === access.membership.actorId)
        return invalidBody("A participant cannot hand a task to itself.");
      const now = Date.now();
      const parentId = typeof body.parentHandoffId === "string" ? body.parentHandoffId : null;
      const requested = Array.isArray(body.grantedCapabilities)
        ? body.grantedCapabilities
        : ["room.read", "message.send", "handoff.create", "task.cancel"];
      if (requested.some((capability) => typeof capability !== "string"))
        return invalidBody("Invalid capability list.");
      const senderActor = actorFor(scope, access.membership.actorKind, access.membership.actorId);
      const recipientActor = actorFor(
        scopeFor(recipient.userId),
        recipient.actorKind,
        recipient.actorId,
      );
      let envelope: CollaborationHandoffEnvelope;
      let input: CollaborationHandoffRow;
      let saved: CollaborationHandoffRow | null;
      const requestedProfileVersion = recipient.profileVersion ?? undefined;
      if (!parentId) {
        const budget = body.budget === undefined ? 4 : body.budget;
        if (
          !Number.isInteger(budget) ||
          (budget as number) < 0 ||
          (budget as number) > MAX_HANDOFF_BUDGET
        )
          return invalidBody(`Handoff budget must be between 0 and ${MAX_HANDOFF_BUDGET}.`);
        envelope = {
          kind: "handoff",
          handoffId: body.handoffId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          roomId,
          taskId: body.taskId.trim(),
          sender: senderActor,
          recipient: recipientActor,
          createdAt: now,
          lineage: {
            rootHandoffId: body.handoffId,
            parentHandoffId: null,
            depth: 0,
            ancestorHandoffIds: [],
          },
          remainingBudget: budget as number,
          grantedCapabilities: requested as CollaborationHandoffEnvelope["grantedCapabilities"],
          ...(requestedProfileVersion !== undefined
            ? { profileVersion: requestedProfileVersion }
            : {}),
        };
        input = {
          handoffId: envelope.handoffId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          roomId,
          taskId: envelope.taskId,
          senderUserId: scope.userId,
          senderActorId: senderActor.actorId,
          recipientUserId: recipient.userId,
          recipientActorId: recipient.actorId,
          parentHandoffId: null,
          rootHandoffId: envelope.handoffId,
          depth: 0,
          ancestorHandoffIds: [],
          remainingBudget: envelope.remainingBudget,
          grantedCapabilities: [...envelope.grantedCapabilities],
          profileVersion: envelope.profileVersion ?? null,
          status: "active",
          createdAt: now,
          cancelledAt: null,
        };
        const validation = validateCollaborationHandoff(envelope, {
          expected: roomFor(access.room),
          senderCapabilities: access.membership.capabilities,
          recipientProfileVersion: recipient.profileVersion,
        });
        if (
          !validation.valid ||
          (recipient.actorKind === "agent" &&
            envelope.grantedCapabilities.includes("approval.decide"))
        ) {
          return invalidBody(
            validation.valid
              ? "Agents cannot receive approval authority."
              : `Invalid handoff envelope: ${validation.reason}.`,
          );
        }
        saved = await createRootCollaborationHandoff(env, scope, input);
      } else {
        const parent = await getCollaborationHandoff(env, scope, parentId);
        if (
          !parent ||
          parent.roomId !== roomId ||
          parent.taskId !== body.taskId ||
          parent.status !== "active" ||
          parent.recipientActorId !== senderActor.actorId ||
          parent.recipientUserId !== scope.userId
        ) {
          return json({ error: "Active parent handoff not found for this participant." }, 404);
        }
        if (parent.recipientActorId.startsWith("agent:")) {
          return json({ error: "Agent handoff execution is not available in this deployment." }, 501);
        }
        const parentEnvelope = envelopeForHandoff(parent);
        const lineage = childHandoffLineage(parentEnvelope);
        if (!lineage) return invalidBody("Maximum handoff depth reached.");
        envelope = {
          kind: "handoff",
          handoffId: body.handoffId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          roomId,
          taskId: parent.taskId,
          sender: senderActor,
          recipient: recipientActor,
          createdAt: now,
          lineage,
          remainingBudget: Math.max(0, parent.remainingBudget - 1),
          grantedCapabilities: requested as CollaborationHandoffEnvelope["grantedCapabilities"],
          ...(requestedProfileVersion !== undefined
            ? { profileVersion: requestedProfileVersion }
            : {}),
        };
        input = {
          handoffId: envelope.handoffId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          roomId,
          taskId: envelope.taskId,
          senderUserId: scope.userId,
          senderActorId: senderActor.actorId,
          recipientUserId: recipient.userId,
          recipientActorId: recipient.actorId,
          parentHandoffId: parent.handoffId,
          rootHandoffId: parent.rootHandoffId,
          depth: lineage.depth,
          ancestorHandoffIds: [...lineage.ancestorHandoffIds],
          remainingBudget: envelope.remainingBudget,
          grantedCapabilities: [...envelope.grantedCapabilities],
          profileVersion: envelope.profileVersion ?? null,
          status: "active",
          createdAt: now,
          cancelledAt: null,
        };
        const validation = validateCollaborationHandoff(envelope, {
          expected: roomFor(access.room),
          senderCapabilities: access.membership.capabilities,
          parent: parentEnvelope,
          recipientProfileVersion: recipient.profileVersion,
          senderProfileVersion: access.membership.profileVersion,
        });
        if (
          !validation.valid ||
          (recipient.actorKind === "agent" &&
            envelope.grantedCapabilities.includes("approval.decide"))
        ) {
          return invalidBody(
            validation.valid
              ? "Agents cannot receive approval authority."
              : `Invalid handoff envelope: ${validation.reason}.`,
          );
        }
        saved = await createChildCollaborationHandoff(env, scope, input);
      }
      if (!saved)
        return json(
          {
            error:
              "Handoff could not be created; the membership or remaining handoff budget may have changed.",
          },
          409,
        );
      return json({ handoff: saved }, 201);
    }

    if (
      path[0] === "handoffs" &&
      path.length === 3 &&
      path[2] === "cancel" &&
      request.method === "POST"
    ) {
      const handoffId = path[1] ?? "";
      const target = await getCollaborationHandoff(env, scope, handoffId);
      if (!target) return json({ error: "Handoff not found." }, 404);
      const access = await authorizeRoomAction(
        env,
        scope,
        target.roomId,
        humanActorId(scope.userId),
        "task.cancel",
      );
      if ("response" in access && access.response) return access.response;
      const cancellation = {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        roomId: target.roomId,
        taskId: target.taskId,
        targetHandoffId: target.handoffId,
        rootHandoffId: target.rootHandoffId,
        ancestorHandoffIds: target.ancestorHandoffIds,
      };
      const valid = validateHandoffCancellation(cancellation, envelopeForHandoff(target));
      if (!valid.valid) return invalidBody("Stored handoff lineage is invalid.");
      const changed = await cancelCollaborationHandoff(env, scope, handoffId, Date.now());
      return changed
        ? json({ cancelled: true })
        : json({ error: "Handoff could not be cancelled." }, 409);
    }

    return json({ error: "Collaboration route or method not found." }, 404);
  } catch (error) {
    if (error instanceof CollaborationStoreError)
      return json({ error: error.message }, error.status);
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message))
      return json({ error: "Duplicate collaboration id." }, 409);
    console.error("collaboration route failed", message);
    return json({ error: "Collaboration operation failed." }, 503);
  }
}
