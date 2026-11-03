import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { isRunRoomEvent, MAX_RUN_ROOM_EVENTS, type RunRoomEvent, type RunRoomFrame, type RunRoomIdentity } from "./run-room-events.js";
import { isValidSessionId } from "./web-sessions.js";
import { timingSafeEqualString } from "./security.js";

const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STREAM_ID = VIEWER_ID;
const MAX_FRAME_CHARS = 8_192;
const MAX_MESSAGE_CHARS = 5_000;
const MAX_STREAM_DELTA_CHARS = 4_000;
const MAX_STREAM_CHARS = 50_000;
const MAX_ROOM_MESSAGES = 200;
const MAX_ROOM_STREAMS = 200;
const TYPING_TTL_MS = 5_000;
const STREAM_TTL_MS = 2 * 60_000;

interface RoomSocketAttachment {
  ownerId: string;
  sessionId: string;
  viewerId: string;
  joinedAt: number;
  typing: boolean;
  typingAt: number;
  connectionId: string;
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

interface RunEventRow {
  [key: string]: string | number;
  sequence: number;
  event_id: string;
  run_id: string;
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
    ) {
      const attachment = { ...value, connectionId: typeof value.connectionId === "string" && VIEWER_ID.test(value.connectionId) ? value.connectionId : crypto.randomUUID() } as unknown as RoomSocketAttachment;
      if (attachment.connectionId !== value.connectionId) socket.serializeAttachment(attachment);
      return attachment;
    }
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
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_stream_owners (
        stream_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        resume_token TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // Exact ping frames can be answered while the object is hibernating.
    ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const ownerId = request.headers.get("x-shiba-room-owner")?.trim().toLowerCase() ?? "";
    const sessionId = request.headers.get("x-shiba-room-session")?.trim() ?? "";
    const viewerId = request.headers.get("x-shiba-room-viewer")?.trim() ?? "";
    if (!ownerId || !isValidSessionId(sessionId) || !VIEWER_ID.test(viewerId)) {
      return Response.json({ error: "Invalid room identity." }, { status: 400 });
    }
    if (!this.bindIdentity(ownerId, sessionId)) {
      return Response.json({ error: "Room identity does not match." }, { status: 403 });
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
      connectionId: crypto.randomUUID(),
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

  /** RPC is exposed only on the Worker binding, never through a client frame. */
  async appendRunEvent(identity: RunRoomIdentity, eventId: string, event: RunRoomEvent): Promise<number> {
    const ownerId = identity.ownerId.trim().toLowerCase();
    if (!ownerId || ownerId.length > 320 || !isValidSessionId(identity.sessionId) ||
      typeof identity.runId !== "string" || !identity.runId || identity.runId.length > 200 ||
      !VIEWER_ID.test(eventId) || !isRunRoomEvent(event)) {
      throw new Error("Invalid run room event.");
    }
    if (!this.bindIdentity(ownerId, identity.sessionId)) throw new Error("Room identity does not match.");
    const existing = this.ctx.storage.sql.exec<{ sequence: number }>(
      "SELECT sequence FROM room_run_events WHERE event_id = ?", eventId,
    ).toArray()[0];
    if (existing) return existing.sequence;
    const createdAt = Date.now();
    const row = this.ctx.storage.sql.exec<{ sequence: number }>(
      "INSERT INTO room_run_events (event_id, run_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
      eventId, identity.runId, JSON.stringify(event), createdAt,
    ).toArray()[0];
    if (!row) throw new Error("Run event was not persisted.");
    this.ctx.storage.sql.exec(
      "DELETE FROM room_run_events WHERE sequence IN (SELECT sequence FROM room_run_events ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      MAX_RUN_ROOM_EVENTS,
    );
    this.broadcast({ type: "run:event", sequence: row.sequence, eventId, runId: identity.runId, createdAt, event } satisfies RunRoomFrame);
    return row.sequence;
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) {
      socket.close(1008, "Room identity is unavailable.");
      return;
    }
    if (raw === "ping") {
      if (socket.readyState === 1) socket.send("pong");
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

    if (event.type === "subscribe") {
      if (!Number.isSafeInteger(event.after) || (event.after as number) < 0) {
        this.send(socket, { type: "error", error: "Invalid replay cursor." });
        return;
      }
      this.replayRunEvents(socket, event.after as number);
      return;
    }

    if (event.type === "ping") {
      this.send(socket, { type: "pong" });
      return;
    }

    if (event.type === "typing" || event.type === "client_presence") {
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

    if (event.type === "message" || event.type === "prompt_input") {
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
      const current = this.getStream(event.streamId);
      const owner = this.streamOwner(event.streamId);
      if (current && (!owner || (owner.connection_id !== attachment.connectionId &&
        (typeof event.resumeToken !== "string" || !timingSafeEqualString(event.resumeToken, owner.resume_token))))) {
        this.send(socket, { type: "error", error: "Stream belongs to another connection." });
        return;
      }
      const resumeToken = owner?.resume_token ?? crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO room_stream_owners (stream_id, connection_id, resume_token) VALUES (?, ?, ?) ON CONFLICT(stream_id) DO UPDATE SET connection_id=excluded.connection_id",
        event.streamId, attachment.connectionId, resumeToken,
      );
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
      this.pruneRelayStreams();
      this.broadcast({ type: "stream:start", streamId: event.streamId, viewerId: attachment.viewerId });
      this.send(socket, { type: "stream:lease", streamId: event.streamId, resumeToken });
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
      if (!current || this.streamOwner(event.streamId)?.connection_id !== attachment.connectionId || current.status !== "streaming") return;
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
      if (!current || this.streamOwner(event.streamId)?.connection_id !== attachment.connectionId || current.status !== "streaming") return;
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
    this.pruneRelayStreams();
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

  private bindIdentity(ownerId: string, sessionId: string): boolean {
    const current = this.ctx.storage.sql.exec<{ owner_id: string; session_id: string }>(
      "SELECT owner_id, session_id FROM room_identity WHERE singleton = 1",
    ).toArray()[0];
    if (current) return current.owner_id === ownerId && current.session_id === sessionId;
    this.ctx.storage.sql.exec(
      "INSERT INTO room_identity (singleton, owner_id, session_id) VALUES (1, ?, ?)", ownerId, sessionId,
    );
    return true;
  }

  private replayRunEvents(socket: WebSocket, after: number): void {
    const bounds = this.ctx.storage.sql.exec<{ oldest: number | null; latest: number | null }>(
      "SELECT MIN(sequence) AS oldest, MAX(sequence) AS latest FROM room_run_events",
    ).toArray()[0];
    const oldest = bounds?.oldest ?? 0;
    const latest = bounds?.latest ?? 0;
    if (after > latest || (oldest > 0 && after < oldest - 1)) {
      this.send(socket, { type: "run:replay_gap", after, oldest, latest });
    }
    const cursor = after > latest ? 0 : after;
    const rows = this.ctx.storage.sql.exec<RunEventRow>(
      "SELECT sequence, event_id, run_id, body, created_at FROM room_run_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      cursor, MAX_RUN_ROOM_EVENTS,
    ).toArray();
    for (const row of rows) {
      this.send(socket, {
        type: "run:event", sequence: row.sequence, eventId: row.event_id,
        runId: row.run_id, createdAt: row.created_at, event: JSON.parse(row.body) as RunRoomEvent,
      } satisfies RunRoomFrame);
    }
    this.send(socket, { type: "run:replay_complete", sequence: latest });
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

  private streamOwner(streamId: string): { connection_id: string; resume_token: string } | undefined {
    return this.ctx.storage.sql.exec<{ connection_id: string; resume_token: string }>(
      "SELECT connection_id, resume_token FROM room_stream_owners WHERE stream_id = ?", streamId,
    ).toArray()[0];
  }

  private pruneRelayStreams(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM room_streams WHERE stream_id IN (SELECT stream_id FROM room_streams ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
      MAX_ROOM_STREAMS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM room_stream_owners WHERE stream_id NOT IN (SELECT stream_id FROM room_streams)",
    );
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
