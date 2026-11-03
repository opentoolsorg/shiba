import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STREAM_ID = VIEWER_ID;
const MAX_FRAME_CHARS = 8_192;
const MAX_MESSAGE_CHARS = 5_000;
const MAX_STREAM_DELTA_CHARS = 4_000;
const MAX_STREAM_CHARS = 50_000;
const MAX_ROOM_MESSAGES = 200;
const TYPING_TTL_MS = 5_000;
const STREAM_TTL_MS = 2 * 60_000;

interface RoomSocketAttachment {
  ownerId: string;
  sessionId: string;
  viewerId: string;
  joinedAt: number;
  typing: boolean;
  typingAt: number;
}

interface RoomViewer {
  viewerId: string;
  joinedAt: number;
  typing: boolean;
}

interface LiveStreamRow {
  [key: string]: string | number;
  stream_id: string;
  viewer_id: string;
  body: string;
  status: string;
  updated_at: number;
}

interface RoomMessageRow {
  [key: string]: string | number;
  message_id: string;
  viewer_id: string;
  body: string;
  created_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentFor(socket: WebSocket): RoomSocketAttachment | null {
  try {
    const value: unknown = socket.deserializeAttachment();
    if (
      isRecord(value) && typeof value.ownerId === "string" &&
      typeof value.sessionId === "string" && typeof value.viewerId === "string" &&
      typeof value.joinedAt === "number" && typeof value.typing === "boolean" &&
      typeof value.typingAt === "number"
    ) return value as unknown as RoomSocketAttachment;
  } catch {
    // A missing or stale attachment is not an active viewer.
  }
  return null;
}

export class ConversationRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_messages (
        message_id TEXT PRIMARY KEY,
        viewer_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_streams (
        stream_id TEXT PRIMARY KEY,
        viewer_id TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const ownerId = request.headers.get("x-shiba-room-owner")?.trim().toLowerCase() ?? "";
    const sessionId = request.headers.get("x-shiba-room-session")?.trim() ?? "";
    const viewerId = request.headers.get("x-shiba-room-viewer")?.trim() ?? "";
    if (!ownerId || !sessionId || !VIEWER_ID.test(viewerId)) {
      return Response.json({ error: "Invalid room identity." }, { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: RoomSocketAttachment = {
      ownerId,
      sessionId,
      viewerId,
      joinedAt: Date.now(),
      typing: false,
      typingAt: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    this.send(server, {
      type: "snapshot",
      viewerId,
      viewers: this.viewers(),
      messages: this.recentMessages(),
      streams: this.activeStreams(),
    });
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) {
      socket.close(1008, "Room identity is unavailable.");
      return;
    }
    if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) {
      this.send(socket, { type: "error", error: "Invalid room event." });
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "error", error: "Invalid room event." });
      return;
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      this.send(socket, { type: "error", error: "Invalid room event." });
      return;
    }

    if (event.type === "typing") {
      if (typeof event.typing !== "boolean") return;
      socket.serializeAttachment({
        ...attachment,
        typing: event.typing,
        typingAt: event.typing ? Date.now() : 0,
      } satisfies RoomSocketAttachment);
      this.broadcastPresence();
      await this.scheduleMaintenanceAlarm();
      return;
    }

    if (event.type === "message") {
      if (
        typeof event.messageId !== "string" || !MESSAGE_ID.test(event.messageId) ||
        typeof event.text !== "string" || !event.text.trim() || event.text.length > MAX_MESSAGE_CHARS
      ) {
        this.send(socket, { type: "error", error: "Invalid room message." });
        return;
      }
      const existing = this.ctx.storage.sql.exec<{ message_id: string }>(
        "SELECT message_id FROM room_messages WHERE message_id = ?",
        event.messageId,
      ).toArray()[0];
      if (existing) return;
      const createdAt = Date.now();
      const text = event.text.trim();
      this.ctx.storage.sql.exec(
        "INSERT INTO room_messages (message_id, viewer_id, body, created_at) VALUES (?, ?, ?, ?)",
        event.messageId,
        attachment.viewerId,
        text,
        createdAt,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM room_messages WHERE message_id IN (SELECT message_id FROM room_messages ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
        MAX_ROOM_MESSAGES,
      );
      this.broadcast({
        type: "message",
        messageId: event.messageId,
        viewerId: attachment.viewerId,
        role: "user",
        text,
        createdAt,
      });
      return;
    }

    if (event.type === "stream:start") {
      if (typeof event.streamId !== "string" || !STREAM_ID.test(event.streamId)) {
        this.send(socket, { type: "error", error: "Invalid stream identity." });
        return;
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO room_streams (stream_id, viewer_id, body, status, created_at, updated_at)
         VALUES (?, ?, '', 'streaming', ?, ?)
         ON CONFLICT(stream_id) DO UPDATE SET viewer_id=excluded.viewer_id, body='', status='streaming', created_at=excluded.created_at, updated_at=excluded.updated_at`,
        event.streamId,
        attachment.viewerId,
        now,
        now,
      );
      this.broadcast({ type: "stream:start", streamId: event.streamId, viewerId: attachment.viewerId });
      await this.scheduleMaintenanceAlarm();
      return;
    }

    if (event.type === "stream:delta") {
      if (
        typeof event.streamId !== "string" || !STREAM_ID.test(event.streamId) ||
        typeof event.delta !== "string" || !event.delta || event.delta.length > MAX_STREAM_DELTA_CHARS
      ) {
        this.send(socket, { type: "error", error: "Invalid stream delta." });
        return;
      }
      const current = this.getStream(event.streamId);
      if (!current || current.viewer_id !== attachment.viewerId || current.status !== "streaming") return;
      const body = `${current.body}${event.delta}`.slice(0, MAX_STREAM_CHARS);
      const updatedAt = Date.now();
      this.ctx.storage.sql.exec(
        "UPDATE room_streams SET body = ?, updated_at = ? WHERE stream_id = ? AND viewer_id = ? AND status = 'streaming'",
        body,
        updatedAt,
        event.streamId,
        attachment.viewerId,
      );
      this.broadcast({
        type: "stream:delta",
        streamId: event.streamId,
        viewerId: attachment.viewerId,
        delta: event.delta,
        text: body,
        updatedAt,
      });
      await this.scheduleMaintenanceAlarm();
      return;
    }

    if (event.type === "stream:end") {
      if (
        typeof event.streamId !== "string" || !STREAM_ID.test(event.streamId) ||
        (event.status !== "complete" && event.status !== "failed")
      ) {
        this.send(socket, { type: "error", error: "Invalid stream completion." });
        return;
      }
      const current = this.getStream(event.streamId);
      if (!current || current.viewer_id !== attachment.viewerId || current.status !== "streaming") return;
      const updatedAt = Date.now();
      this.ctx.storage.sql.exec(
        "UPDATE room_streams SET status = ?, updated_at = ? WHERE stream_id = ? AND viewer_id = ? AND status = 'streaming'",
        event.status,
        updatedAt,
        event.streamId,
        attachment.viewerId,
      );
      this.broadcast({
        type: "stream:end",
        streamId: event.streamId,
        viewerId: attachment.viewerId,
        status: event.status,
        updatedAt,
      });
      await this.scheduleMaintenanceAlarm();
      return;
    }

    this.send(socket, { type: "error", error: "Unsupported room event." });
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence();
    await this.scheduleMaintenanceAlarm();
  }

  async webSocketError(): Promise<void> {
    this.broadcastPresence();
    await this.scheduleMaintenanceAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment?.typing && attachment.typingAt + TYPING_TTL_MS <= now) {
        socket.serializeAttachment({ ...attachment, typing: false, typingAt: 0 } satisfies RoomSocketAttachment);
      }
    }
    const expiredStreams = this.ctx.storage.sql.exec<{ [key: string]: string; stream_id: string; viewer_id: string }>(
      "UPDATE room_streams SET status = 'failed', updated_at = ? WHERE status = 'streaming' AND updated_at <= ? RETURNING stream_id, viewer_id",
      now,
      now - STREAM_TTL_MS,
    ).toArray();
    for (const stream of expiredStreams) {
      this.broadcast({
        type: "stream:end",
        streamId: stream.stream_id,
        viewerId: stream.viewer_id,
        status: "failed",
        updatedAt: now,
      });
    }
    this.broadcastPresence();
    await this.scheduleMaintenanceAlarm();
  }

  private viewers(): RoomViewer[] {
    const now = Date.now();
    const unique = new Map<string, RoomViewer>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = attachmentFor(socket);
      if (!attachment) continue;
      unique.set(attachment.viewerId, {
        viewerId: attachment.viewerId,
        joinedAt: attachment.joinedAt,
        typing: attachment.typing && attachment.typingAt + TYPING_TTL_MS > now,
      });
    }
    return [...unique.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private activeStreams(): Array<{ streamId: string; viewerId: string; text: string }> {
    const cutoff = Date.now() - STREAM_TTL_MS;
    return this.ctx.storage.sql.exec<LiveStreamRow>(
      "SELECT stream_id, viewer_id, body, status, updated_at FROM room_streams WHERE status = 'streaming' AND updated_at >= ? ORDER BY created_at DESC LIMIT 5",
      cutoff,
    ).toArray().map((stream) => ({
      streamId: stream.stream_id,
      viewerId: stream.viewer_id,
      text: stream.body,
    }));
  }

  private recentMessages(): Array<{ messageId: string; viewerId: string; role: "user"; text: string; createdAt: number }> {
    return this.ctx.storage.sql.exec<RoomMessageRow>(
      "SELECT message_id, viewer_id, body, created_at FROM room_messages ORDER BY created_at DESC LIMIT ?",
      MAX_ROOM_MESSAGES,
    ).toArray().reverse().map((message) => ({
      messageId: message.message_id,
      viewerId: message.viewer_id,
      role: "user",
      text: message.body,
      createdAt: message.created_at,
    }));
  }

  private getStream(streamId: string): LiveStreamRow | undefined {
    return this.ctx.storage.sql.exec<LiveStreamRow>(
      "SELECT stream_id, viewer_id, body, status, updated_at FROM room_streams WHERE stream_id = ?",
      streamId,
    ).toArray()[0];
  }

  private send(socket: WebSocket, event: unknown): void {
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A disconnected viewer must not prevent room fanout to others.
    }
  }

  private broadcast(event: unknown): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, event);
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", viewers: this.viewers() });
  }

  private async scheduleMaintenanceAlarm(): Promise<void> {
    const expiries = this.ctx.getWebSockets()
      .filter((socket) => socket.readyState === 1)
      .map(attachmentFor)
      .filter((attachment): attachment is RoomSocketAttachment => Boolean(attachment?.typing))
      .map((attachment) => attachment.typingAt + TYPING_TTL_MS);
    const streams = this.ctx.storage.sql.exec<{ [key: string]: string | number; updated_at: number }>(
      "SELECT updated_at FROM room_streams WHERE status = 'streaming'",
    ).toArray();
    expiries.push(...streams.map((stream) => stream.updated_at + STREAM_TTL_MS));
    const expiry = expiries.reduce((earliest, item) => Math.min(earliest, item), Infinity);
    if (Number.isFinite(expiry)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, expiry));
    else await this.ctx.storage.deleteAlarm();
  }
}
