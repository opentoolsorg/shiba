/**
 * Hibernatable WebSocket fan-out per workspace. WS05/WS08 publish via
 * `publishWorkspaceEvent`; browsers subscribe at `/api/workspaces/:id/events`.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export type WorkspaceEventMessage = {
  type: string;
  resourceId: string;
  version: number;
  at: number;
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
      if (!body?.type || !body.resourceId || !Number.isFinite(body.version)) {
        return Response.json({ error: "Invalid event." }, { status: 400 });
      }
      const payload = JSON.stringify({ ...body, at: body.at ?? Date.now() });
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
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
  env: Env,
  workspaceId: string,
  event: Omit<WorkspaceEventMessage, "at"> & { at?: number },
): Promise<void> {
  if (!env.WorkspaceEvents) return;
  const stub = env.WorkspaceEvents.getByName(workspaceEventsName(workspaceId));
  await stub.fetch(
    new Request("https://workspace-events.internal/internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, at: event.at ?? Date.now() }),
    }),
  );
}