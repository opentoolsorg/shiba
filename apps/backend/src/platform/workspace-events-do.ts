/**
 * Hibernatable WebSocket fan-out per workspace. Publishers call
 * `publishWorkspaceEvent`, which POSTs to `/internal/publish`. Browsers
 * subscribe at `/api/workspaces/:id/events`.
 *
 * A published event may name an audience. With no audience the event goes to
 * every authenticated socket in the workspace. With an audience it goes only
 * to sockets whose user is listed, or whose user is a member of the named
 * room. Room membership is read on the server. The socket user id is taken
 * from the verified subscriber header the Worker sets after authentication.
 */
import { DurableObject } from "cloudflare:workers";
import { COLLAB_TENANT_ID, getCollaborationMembership, humanActorId } from "../collaboration-store.js";
import type { Env } from "../env.js";

export const VERIFIED_SUBSCRIBER_HEADER = "x-shiba-verified-user";

export type WorkspaceEventAudience = {
  userIds?: string[];
  roomId?: string;
};

export type WorkspaceEvent = {
  id: string;
  workspaceId: string;
  kind: string;
  entityId: string;
  payload: unknown;
  audience?: WorkspaceEventAudience;
};

/** Canonical event, or the previous `{type, resourceId, version}` body. */
export type PublishWorkspaceEventInput =
  | (Omit<WorkspaceEvent, "workspaceId" | "payload"> & {
      workspaceId?: string;
      payload?: unknown;
      at?: number;
    })
  | {
      type: string;
      resourceId: string;
      version: number;
      at?: number;
      audience?: WorkspaceEventAudience;
      workspaceId?: string;
    };

type SocketMeta = { userId: string; joinedAt: number };

type PublishedEvent = {
  wire: Record<string, unknown>;
  workspaceId: string;
  audience?: WorkspaceEventAudience;
};

const USER_MAX = 320;
const TEXT_MAX = 200;
const ROOM_ID = /^(?:room_[a-f0-9]{24}|(?:chn|dm)_[a-f0-9]{20})$/;

function cleanUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const userId = value.trim().toLowerCase();
  if (!userId || userId.length > USER_MAX || userId.includes("\0")) return null;
  return userId;
}

function requiredText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

/** Audience is absent when the body names no users and no room. Invalid shapes fail closed. */
function parseWorkspaceEventAudience(value: unknown): WorkspaceEventAudience | undefined | null {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const audience: WorkspaceEventAudience = {};
  if (record.userIds != null) {
    if (!Array.isArray(record.userIds) || record.userIds.length > 100) return null;
    const ids: string[] = [];
    for (const item of record.userIds) {
      const id = cleanUserId(item);
      if (!id) return null;
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) audience.userIds = ids;
  }
  if (record.roomId != null) {
    if (typeof record.roomId !== "string" || !ROOM_ID.test(record.roomId.trim().toLowerCase())) return null;
    audience.roomId = record.roomId.trim().toLowerCase();
  }
  if (!audience.userIds && !audience.roomId) return undefined;
  return audience;
}

function parsePublishedEvent(body: unknown, now: number): PublishedEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const audience = parseWorkspaceEventAudience(record.audience);
  if (audience === null) return null;
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : now;
  const legacyType = typeof record.type === "string" ? record.type.trim() : "";
  const legacyResource = typeof record.resourceId === "string" ? record.resourceId.trim() : "";
  const legacyVersion = typeof record.version === "number" && Number.isFinite(record.version) ? record.version : undefined;
  const hasLegacy = legacyType.length > 0 && legacyResource.length > 0 && legacyVersion !== undefined;
  const kind = requiredText(record.kind, 80);
  const entityId = requiredText(record.entityId, TEXT_MAX);
  const id = requiredText(record.id, TEXT_MAX);
  const workspaceId = requiredText(record.workspaceId, TEXT_MAX)?.toLowerCase() ?? null;

  if (kind && entityId && id && workspaceId) {
    const wire: Record<string, unknown> = {
      id,
      workspaceId,
      kind,
      entityId,
      payload: "payload" in record ? record.payload : null,
      at,
    };
    if (hasLegacy) {
      wire.type = legacyType;
      wire.resourceId = legacyResource;
      wire.version = legacyVersion;
    }
    return { wire, workspaceId, audience };
  }

  if (!hasLegacy || !workspaceId) return null;
  return {
    workspaceId,
    audience,
    wire: {
      id: `legacy:${legacyType}:${legacyResource}:${legacyVersion}`.slice(0, TEXT_MAX),
      workspaceId,
      kind: legacyType.slice(0, 80),
      entityId: legacyResource.slice(0, TEXT_MAX),
      payload: { version: legacyVersion },
      type: legacyType,
      resourceId: legacyResource,
      version: legacyVersion,
      at,
    },
  };
}

function socketUserId(ws: WebSocket): string | null {
  const meta = ws.deserializeAttachment() as Partial<SocketMeta> | null;
  return cleanUserId(meta?.userId);
}

async function isRoomMember(env: Env, workspaceId: string, roomId: string, userId: string): Promise<boolean> {
  if (!env.AGENT_AUDIT) return false;
  try {
    const membership = await getCollaborationMembership(
      env,
      { tenantId: COLLAB_TENANT_ID, workspaceId, userId },
      roomId,
      humanActorId(userId),
    );
    return membership !== null && membership.status === "active";
  } catch {
    return false;
  }
}

export function workspaceEventsName(workspaceId: string): string {
  return workspaceId.trim().toLowerCase();
}

export async function publishWorkspaceEvent(
  env: Env,
  workspaceId: string,
  event: PublishWorkspaceEventInput,
): Promise<void> {
  if (!env.WorkspaceEvents) return;
  const name = workspaceEventsName(workspaceId);
  if (!name) return;
  const stub = env.WorkspaceEvents.getByName(name);
  await stub.fetch(
    new Request("https://workspace-events.internal/internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        workspaceId: name,
        at: event.at ?? Date.now(),
      }),
    }),
  );
}

export class WorkspaceEvents extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/publish" && request.method === "POST") {
      return this.publish(request);
    }
    if (url.pathname === "/subscribe" && request.headers.get("Upgrade") === "websocket") {
      return this.subscribe(request);
    }
    return new Response(null, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message.trim() === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close(1000, "closed");
  }

  private async publish(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const published = parsePublishedEvent(body, Date.now());
    if (!published) return Response.json({ error: "Invalid event." }, { status: 400 });
    const payload = JSON.stringify(published.wire);
    const membership = new Map<string, Promise<boolean>>();
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const userId = socketUserId(ws);
      if (!userId || !(await this.visibleTo(userId, published, membership))) continue;
      try {
        ws.send(payload);
        delivered += 1;
      } catch {
        /* stale socket */
      }
    }
    return Response.json({ ok: true, delivered });
  }

  private subscribe(request: Request): Response {
    const userId = cleanUserId(request.headers.get(VERIFIED_SUBSCRIBER_HEADER));
    if (!userId) return new Response("Invalid subscriber.", { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, joinedAt: Date.now() } satisfies SocketMeta);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async visibleTo(userId: string, published: PublishedEvent, membership: Map<string, Promise<boolean>>): Promise<boolean> {
    const audience = published.audience;
    if (!audience) return true;
    if (audience.userIds?.includes(userId)) return true;
    if (!audience.roomId) return false;
    const key = `${audience.roomId}\0${userId}`;
    let pending = membership.get(key);
    if (!pending) {
      pending = isRoomMember(this.env, published.workspaceId, audience.roomId, userId);
      membership.set(key, pending);
    }
    return pending;
  }
}
