/**
 * Hibernatable WebSocket fan-out per workspace. WS05/WS08 publish via
 * `publishWorkspaceEvent`; browsers subscribe at `/api/workspaces/:id/events`.
 */
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceEvent } from "@shiba/shared";
import type { Env } from "../env.js";

export type WorkspaceEventMessage = WorkspaceEvent & {
  /** Legacy fields kept so older publishers still validate. */
  type?: string;
  resourceId?: string;
  version?: number;
};

type SocketMeta = { userId: string; joinedAt: number };

export class WorkspaceEvents extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/publish" && request.method === "POST") {
      let body: WorkspaceEventMessage;
      try {
        body = (await request.json()) as WorkspaceEventMessage;
      } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
      }
      const kind = body.kind || body.type;
      const entityId = body.entityId || body.resourceId;
      if (!kind || !entityId) {
        return Response.json({ error: "Invalid event." }, { status: 400 });
      }
      const frame = {
        ...body,
        kind,
        entityId,
        at: body.at ?? Date.now(),
        type: body.type ?? kind,
        resourceId: body.resourceId ?? entityId,
        version: body.version ?? body.at ?? Date.now(),
      };
      const payload = JSON.stringify(frame);
      const allowed = new Set((frame.audience?.userIds ?? []).map((id: string) => id.trim().toLowerCase()));
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        if (allowed.size > 0) {
          const meta = ws.deserializeAttachment() as { userId?: string } | null;
          if (!meta?.userId || !allowed.has(meta.userId)) continue;
        }
        try {
          ws.send(payload);
        } catch {
          /* stale socket */
        }
      }
      return Response.json({ ok: true, delivered: sockets.length });
    }
    if (url.pathname === "/subscribe" && request.headers.get("Upgrade") === "websocket") {
      const userId = url.searchParams.get("userId")?.trim().toLowerCase() ?? "";
      if (!userId || userId.length > 320) return new Response("Invalid subscriber.", { status: 400 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId, joinedAt: Date.now() } satisfies SocketMeta);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(null, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message.trim() === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close(1000, "closed");
  }
}

export function workspaceEventsName(workspaceId: string): string {
  return workspaceId.trim().toLowerCase();
}

export async function publishWorkspaceEvent(
  env: Pick<Env, "WorkspaceEvents">,
  workspaceId: string,
  event: Omit<WorkspaceEvent, "id" | "workspaceId" | "at"> & { id?: string; at?: number },
): Promise<void> {
  if (!env.WorkspaceEvents) return;
  const at = event.at ?? Date.now();
  const stub = env.WorkspaceEvents.getByName(workspaceEventsName(workspaceId));
  await stub.fetch(
    new Request("https://workspace-events.internal/internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        id: event.id ?? `wse_${at}`,
        workspaceId,
        at,
        type: event.kind,
        resourceId: event.entityId,
        version: at,
      }),
    }),
  );
}