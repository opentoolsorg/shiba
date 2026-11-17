import type { WorkspaceMessagePatch } from "@shiba/shared";
import { handleCollaboration } from "./collaboration-routes.js";
import { handleCollaborationApproval } from "./collaboration-approval-routes.js";
import { handleCollaborationArtifact } from "./collaboration-artifact-routes.js";
import { handleCollaborationShare } from "./collaboration-share-routes.js";
import { handleCollaborationLive } from "./collaboration-live-routes.js";
import type { CollaborationScope } from "./collaboration-store.js";
import { canReadCollaborationRoom, collaborationRoomName } from "./collaboration-room-access.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { authenticatedRoomViewerId } from "./run-room-events.js";
import { resolveTeamCollaborationScope } from "./team-collaboration-scope.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";

const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wrap durable HTTP mutations with content-free, membership-checked invalidations. */
export async function handleCollaborationWithRealtime(request: Request, env: Env): Promise<Response | null> {
  const approval = await handleCollaborationApproval(request, env);
  if (approval) return approval;
  const url = new URL(request.url);
  const live = url.pathname.match(/^\/api\/collaboration\/rooms\/([^/]+)\/realtime$/);
  if (live) {
    if (!(await isAuthorizedRequest(request, env))) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "WebSocket upgrade required." }, { status: 426 });
    if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Invalid room origin." }, { status: 403 });
    if (!env.AGENT_AUDIT) return Response.json({ error: "Collaboration storage is unavailable." }, { status: 503 });
    let scope: CollaborationScope | null;
    try {
      scope = await resolveTeamCollaborationScope(request, env);
      if (!scope || !(await canReadCollaborationRoom(env, { ...scope, roomId: live[1]! }, scope.userId))) return Response.json({ error: "Room not found." }, { status: 404 });
    } catch {
      return Response.json({ error: "Room membership could not be verified." }, { status: 503 });
    }
    const nonce = url.searchParams.get("viewer") ?? "";
    if (!VIEWER_ID.test(nonce) || url.searchParams.getAll("viewer").length !== 1) return Response.json({ error: "Invalid room viewer." }, { status: 400 });
    if (!env.ConversationRoom) return Response.json({ error: "Room realtime is unavailable." }, { status: 503 });
    const identity = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId: live[1]! };
    // The internal path selects the mode. Client-supplied room headers on ordinary
    // session routes cannot turn their owner-scoped sockets into shared ones.
    const headers = new Headers({ Upgrade: "websocket" });
    headers.set("x-shiba-room-tenant", identity.tenantId);
    headers.set("x-shiba-room-workspace", identity.workspaceId);
    headers.set("x-shiba-room-session", identity.roomId);
    headers.set("x-shiba-room-actor", scope.userId);
    headers.set("x-shiba-room-viewer", await authenticatedRoomViewerId(scope.userId, nonce));
    try {
      const freshScope = await resolveTeamCollaborationScope(request, env);
      if (!freshScope || freshScope.userId !== scope.userId || freshScope.workspaceId !== scope.workspaceId ||
        !await canReadCollaborationRoom(env, identity, scope.userId)) return Response.json({ error: "Room not found." }, { status: 404 });
    } catch {
      return Response.json({ error: "Room membership could not be verified." }, { status: 503 });
    }
    return env.ConversationRoom.getByName(collaborationRoomName(identity)).fetch(new Request("https://internal/internal/collaboration-room", { headers }));
  }
  const execution = await handleCollaborationLive(request, env);
  if (execution) return execution;
  const artifact = await handleCollaborationArtifact(request, env);
  if (artifact) return artifact;
  const messageInput = request.method === "POST" && /\/rooms\/[^/]+\/messages$/.test(url.pathname)
    ? await request.clone().json().catch(() => null) as { threadRootMessageId?: string } | null : null;
  const shared = await handleCollaborationShare(request, env);
  const response = shared ?? await handleCollaboration(request, env);
  if (response?.ok && request.method !== "GET" && request.method !== "HEAD") {
    const body = await response.clone().json().catch(() => null) as {
      room?: { roomId: string; title: string; visibility: string; kind?: string };
      channel?: { roomId: string; title: string; visibility: string; kind?: string };
      dm?: { roomId: string; title: string; visibility: string; kind?: string };
      roomId?: string; handoff?: { roomId?: string };
      message?: WorkspaceMessagePatch;
    } | null;
    const changedRoom = body?.room ?? body?.channel ?? body?.dm;
    let roomId = changedRoom?.roomId ?? url.pathname.match(/^\/api\/collaboration\/rooms\/([^/]+)(?:\/|$)/)?.[1];
    if (!roomId && /^\/api\/collaboration\/handoffs\//.test(url.pathname)) {
      roomId = body?.roomId ?? body?.handoff?.roomId;
    }
    if (roomId) {
      try {
        const scope = await resolveTeamCollaborationScope(request, env);
        if (scope) {
          const identity = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, roomId };
          await env.ConversationRoom?.getByName(collaborationRoomName(identity)).notifyCollaborationChange(identity)
            .catch(() => { /* Workspace transport can still deliver the committed change. */ });
          const saved = body?.message;
          // Only native human messages have identical visibility for all current room readers.
          const message: WorkspaceMessagePatch | undefined = saved?.senderKind === "human" &&
            request.method === "POST" && /\/rooms\/[^/]+\/messages$/.test(url.pathname) ? {
              messageId: saved.messageId, senderUserId: saved.senderUserId, senderActorId: saved.senderActorId,
              senderKind: "human", body: saved.body, createdAt: saved.createdAt, threadRootId: typeof messageInput?.threadRootMessageId === "string" ? messageInput.threadRootMessageId : null,
            } : undefined;
          await publishWorkspaceEvent(env, scope.workspaceId, {
            kind: changedRoom ? "room.updated" : message ? "message.created" : "collaboration.change",
            audience: { roomId },
            entityId: roomId,
            payload: changedRoom ? { room: {
              roomId, title: changedRoom.title, visibility: changedRoom.visibility,
              kind: changedRoom.kind ?? (body?.channel ? "channel" : body?.dm ? "dm" : "room"),
            } } : message ? { message } : {},
          });
        }
      } catch {
        // D1 is authoritative. A failed hint never rolls back an accepted write;
        // reconnect and the periodic HTTP refresh reconcile it.
        console.warn("Collaboration realtime notification unavailable.");
      }
    }
  }
  return response;
}
