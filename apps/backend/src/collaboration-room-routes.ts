import { handleCollaboration } from "./collaboration-routes.js";
import { handleCollaborationArtifact } from "./collaboration-artifact-routes.js";
import { COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID } from "./collaboration-store.js";
import { canReadCollaborationRoom, collaborationRoomName } from "./collaboration-room-access.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { authenticatedRoomViewerId } from "./run-room-events.js";

const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wrap durable HTTP mutations with content-free, membership-checked invalidations. */
export async function handleCollaborationWithRealtime(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const live = url.pathname.match(/^\/api\/collaboration\/rooms\/([^/]+)\/realtime$/);
  if (live) {
    if (!(await isAuthorizedRequest(request, env))) return Response.json({ error: "Authentication required." }, { status: 401 });
    if (request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "WebSocket upgrade required." }, { status: 426 });
    if (request.headers.get("Origin") !== url.origin) return Response.json({ error: "Invalid room origin." }, { status: 403 });
    const userId = (await resolveUserId(request, env))?.trim().toLowerCase();
    if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
    const identity = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, roomId: live[1]! };
    if (!env.AGENT_AUDIT) return Response.json({ error: "Collaboration storage is unavailable." }, { status: 503 });
    try {
      if (!(await canReadCollaborationRoom(env, identity, userId))) return Response.json({ error: "Room not found." }, { status: 404 });
    } catch {
      return Response.json({ error: "Room membership could not be verified." }, { status: 503 });
    }
    const nonce = url.searchParams.get("viewer") ?? "";
    if (!VIEWER_ID.test(nonce) || url.searchParams.getAll("viewer").length !== 1) return Response.json({ error: "Invalid room viewer." }, { status: 400 });
    if (!env.ConversationRoom) return Response.json({ error: "Room realtime is unavailable." }, { status: 503 });
    // The internal path selects the mode. Client-supplied room headers on ordinary
    // session routes cannot turn their owner-scoped sockets into shared ones.
    const headers = new Headers({ Upgrade: "websocket" });
    headers.set("x-shiba-room-tenant", identity.tenantId);
    headers.set("x-shiba-room-workspace", identity.workspaceId);
    headers.set("x-shiba-room-session", identity.roomId);
    headers.set("x-shiba-room-actor", userId);
    headers.set("x-shiba-room-viewer", await authenticatedRoomViewerId(userId, nonce));
    return env.ConversationRoom.getByName(collaborationRoomName(identity)).fetch(new Request("https://internal/internal/collaboration-room", { headers }));
  }
  const artifact = await handleCollaborationArtifact(request, env);
  if (artifact) return artifact;
  const response = await handleCollaboration(request, env);
  if (response?.ok && request.method !== "GET" && request.method !== "HEAD" && env.ConversationRoom) {
    let roomId = url.pathname.match(/^\/api\/collaboration\/rooms\/([^/]+)(?:\/|$)/)?.[1];
    if (!roomId && /^\/api\/collaboration\/handoffs\//.test(url.pathname)) {
      const body = await response.clone().json().catch(() => null) as { roomId?: string; handoff?: { roomId?: string } } | null;
      roomId = body?.roomId ?? body?.handoff?.roomId;
    }
    if (roomId) {
      const identity = { tenantId: COLLAB_TENANT_ID, workspaceId: COLLAB_WORKSPACE_ID, roomId };
      try {
        await env.ConversationRoom.getByName(collaborationRoomName(identity)).notifyCollaborationChange(identity);
      } catch {
        // D1 is authoritative. A failed hint never rolls back an accepted write;
        // reconnect and the periodic HTTP refresh reconcile it.
        console.warn("Collaboration realtime notification unavailable.");
      }
    }
  }
  return response;
}
