import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { isRunRoomEvent, MAX_RUN_ROOM_EVENTS, MAX_RUN_JOURNAL_FRAMES, MAX_RUN_JOURNAL_EVENTS, MAX_RUN_JOURNAL_CHARS, MAX_RUN_JOURNAL_BATCH_EVENTS, MAX_RUN_JOURNAL_BATCH_CHARS, type RunJournalIdentity, type RunJournalBatch, type RunRoomEvent, type RunRoomFrame, type RunRoomIdentity } from "./run-room-events.js";
import { isValidSessionId } from "./web-sessions.js";
import { timingSafeEqualString } from "./security.js";
import { canReadCollaborationRoom, isCollaborationRoomIdentity, type CollaborationRoomIdentity } from "./collaboration-room-access.js";

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
const CURSOR_TTL_MS = 15_000;
const CURSOR_INTERVAL_MS = 100;
const STREAM_TTL_MS = 2 * 60_000;
const JOURNAL_ID = /^[a-f0-9]{64}$/;
const MEMBERSHIP_RECHECK_MS = 15_000;
const MAX_COLLABORATION_SOCKETS = 64;

interface RunJournalRow {
  [key: string]: string | number;
  run_id: string;
  generation: string;
  acknowledged_through: number;
  source_sequence: number;
  event_count: number;
  character_count: number;
}

interface RoomCursor { x: number; y: number }

interface RoomSocketAttachment {
  ownerId: string;
  actorId: string;
  sessionId: string;
  viewerId: string;
  joinedAt: number;
  typing: boolean;
  typingAt: number;
  connectionId: string;
  viewerLabel: string;
  cursor: RoomCursor | null;
  cursorAt: number;
  readOnly?: boolean;
  runId?: string;
  collaboration?: CollaborationRoomIdentity;
}

interface RoomViewer {
  viewerId: string;
  joinedAt: number;
  typing: boolean;
  label: string;
  cursor: RoomCursor | null;
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

export interface RunRoomReplay {
  runId: string;
  after: number;
  oldest: number;
  latest: number;
  nextCursor: number;
  hasMore: boolean;
  gap: boolean;
  frames: RunRoomFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursor(value: unknown): value is RoomCursor {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1 &&
    typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
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
      const attachment = {
        ...value,
        connectionId: typeof value.connectionId === "string" && VIEWER_ID.test(value.connectionId) ? value.connectionId : crypto.randomUUID(),
        actorId: typeof value.actorId === "string" && value.actorId ? value.actorId : value.ownerId,
        viewerLabel: typeof value.actorId === "string" && value.actorId ? value.actorId : value.ownerId,
        cursor: isCursor(value.cursor) ? { x: value.cursor.x, y: value.cursor.y } : null,
        cursorAt: typeof value.cursorAt === "number" ? value.cursorAt : 0,
      } as unknown as RoomSocketAttachment;
      if (attachment.connectionId !== value.connectionId || attachment.viewerLabel !== value.viewerLabel) socket.serializeAttachment(attachment);
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
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_run_journals (
        job_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        acknowledged_through INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        character_count INTEGER NOT NULL
      )
    `);
    // Receipts survive display-history pruning. They contain hashes, never raw CLI bytes.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_run_journal_receipts (
        job_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (job_id, event_id)
      )
    `);
    // Exact ping frames can be answered while the object is hibernating.
    ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/collaboration-room") return this.fetchCollaboration(request);
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const ownerId = request.headers.get("x-shiba-room-owner")?.trim().toLowerCase() ?? "";
    const actorId = request.headers.get("x-shiba-room-actor")?.trim().toLowerCase() ?? "";
    const sessionId = request.headers.get("x-shiba-room-session")?.trim() ?? "";
    const viewerId = request.headers.get("x-shiba-room-viewer")?.trim() ?? "";
    const readOnly = request.headers.get("x-shiba-room-readonly") === "true";
    const runId = request.headers.get("x-shiba-room-run") ?? "";
    if (!ownerId || ownerId.length > 320 || !actorId || actorId.length > 320 || (!readOnly && actorId !== ownerId) || !isValidSessionId(sessionId) || !VIEWER_ID.test(viewerId) ||
      (readOnly && (!runId || runId.length > 200))) {
      return Response.json({ error: "Invalid room identity." }, { status: 400 });
    }
    if (!this.bindIdentity(ownerId, sessionId)) {
      return Response.json({ error: "Room identity does not match." }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: RoomSocketAttachment = {
      ownerId,
      actorId,
      sessionId,
      viewerId,
      joinedAt: Date.now(),
      typing: false,
      typingAt: 0,
      connectionId: crypto.randomUUID(),
      viewerLabel: actorId,
      cursor: null,
      cursorAt: 0,
      ...(readOnly ? { readOnly: true, runId } : {}),
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    this.send(server, {
      type: "snapshot",
      viewerId,
      viewers: this.viewers(),
      messages: readOnly ? [] : this.recentMessages(),
      streams: readOnly ? [] : this.activeStreams(),
    });
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async fetchCollaboration(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required.", { status: 426 });
    const identity: CollaborationRoomIdentity = {
      tenantId: request.headers.get("x-shiba-room-tenant") ?? "",
      workspaceId: request.headers.get("x-shiba-room-workspace") ?? "",
      roomId: request.headers.get("x-shiba-room-session") ?? "",
    };
    const actorId = request.headers.get("x-shiba-room-actor") ?? "";
    const viewerId = request.headers.get("x-shiba-room-viewer") ?? "";
    if (!isCollaborationRoomIdentity(identity) || !VIEWER_ID.test(viewerId) || !(await canReadCollaborationRoom(this.env, identity, actorId))) {
      return Response.json({ error: "Room not found." }, { status: 404 });
    }
    if (!this.bindIdentity(`collaboration:${identity.tenantId}:${identity.workspaceId}`, identity.roomId)) return Response.json({ error: "Room identity does not match." }, { status: 403 });
    const authorized = await this.authorizedCollaborationSockets();
    // Another upgrade may finish during the D1 checks above. Check the live
    // count without yielding between enforcing the bound and accepting a socket.
    const connected = this.ctx.getWebSockets().filter((socket) => socket.readyState === 1 && attachmentFor(socket)?.collaboration).length;
    if (connected >= MAX_COLLABORATION_SOCKETS) return Response.json({ error: "Room connection limit reached." }, { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.serializeAttachment({
      ownerId: `collaboration:${identity.tenantId}:${identity.workspaceId}`,
      actorId, sessionId: identity.roomId, viewerId, joinedAt: Date.now(), typing: false,
      typingAt: 0, connectionId: crypto.randomUUID(), viewerLabel: actorId,
      cursor: null, cursorAt: 0, collaboration: identity,
    } satisfies RoomSocketAttachment);
    this.ctx.acceptWebSocket(server);
    const sockets = [...authorized, server];
    this.send(server, { type: "collaboration:snapshot", roomId: identity.roomId, selfViewerId: viewerId, viewers: this.collaborationViewers(sockets) });
    this.broadcastCollaborationPresence(sockets, identity.roomId);
    await this.scheduleMaintenanceAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Content-free notifications only; durable messages remain behind the HTTP grants. */
  async notifyCollaborationChange(identity: CollaborationRoomIdentity): Promise<void> {
    if (!isCollaborationRoomIdentity(identity) || !this.bindIdentity(`collaboration:${identity.tenantId}:${identity.workspaceId}`, identity.roomId)) throw new Error("Invalid collaboration room identity.");
    const sockets = await this.authorizedCollaborationSockets();
    for (const socket of sockets) this.send(socket, { type: "collaboration:refresh", roomId: identity.roomId });
    this.broadcastCollaborationPresence(sockets, identity.roomId);
    await this.scheduleMaintenanceAlarm();
  }

  private async authorizedCollaborationSockets(): Promise<WebSocket[]> {
    const authorized: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = attachmentFor(socket);
      if (!attachment?.collaboration) continue;
      try {
        if (await canReadCollaborationRoom(this.env, attachment.collaboration, attachment.actorId)) {
          authorized.push(socket);
          continue;
        }
        socket.close(1008, "Room access ended.");
      } catch {
        socket.close(1011, "Room membership could not be verified.");
      }
    }
    return authorized;
  }

  private collaborationViewers(sockets: WebSocket[]): Array<{ viewerId: string; label: string; typing: boolean; cursor: RoomCursor | null }> {
    const viewers = new Map<string, { viewerId: string; label: string; typing: boolean; cursor: RoomCursor | null }>();
    for (const socket of sockets) {
      const attachment = attachmentFor(socket);
      if (!attachment?.collaboration) continue;
      viewers.set(attachment.viewerId, { viewerId: attachment.viewerId, label: attachment.actorId, typing: attachment.typing && attachment.typingAt + TYPING_TTL_MS > Date.now(), cursor: attachment.cursor && attachment.cursorAt + CURSOR_TTL_MS > Date.now() ? attachment.cursor : null });
    }
    return [...viewers.values()];
  }

  private broadcastCollaborationPresence(sockets: WebSocket[], roomId: string): void {
    const event = { type: "collaboration:presence", roomId, viewers: this.collaborationViewers(sockets) };
    for (const socket of sockets) this.send(socket, event);
  }

  private async collaborationMessage(socket: WebSocket, attachment: RoomSocketAttachment, raw: string | ArrayBuffer): Promise<void> {
    const authorized = await this.authorizedCollaborationSockets();
    if (!authorized.includes(socket)) return;
    if (raw === "ping") { this.send(socket, { type: "pong" }); return; }
    if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) { this.send(socket, { type: "error", error: "Invalid room event." }); return; }
    let event: unknown;
    try { event = JSON.parse(raw); } catch { this.send(socket, { type: "error", error: "Invalid room event." }); return; }
    if (isRecord(event) && event.type === "ping") { this.send(socket, { type: "pong" }); return; }
    if (!isRecord(event) || event.type !== "client_presence") {
      this.send(socket, { type: "error", error: "Shared room sockets only accept presence. Use the authenticated room actions." });
      return;
    }
    const hasTyping = typeof event.typing === "boolean", hasCursor = Object.hasOwn(event, "cursor");
    if ((!hasTyping && !hasCursor) || hasCursor && event.cursor !== null && (!isCursor(event.cursor) || Object.keys(event.cursor).some((key) => key !== "x" && key !== "y"))) {
      this.send(socket, { type: "error", error: "Invalid room presence." }); return;
    }
    // Authorization yielded. Read the current attachment before throttling so
    // concurrent frames cannot reuse an older cursor timestamp.
    const latest = attachmentFor(socket);
    if (!latest?.collaboration || socket.readyState !== 1) return;
    const now = Date.now();
    const updateCursor = hasCursor && (event.cursor === null ? latest.cursor !== null : now - latest.cursorAt >= CURSOR_INTERVAL_MS);
    if (hasCursor && event.cursor !== null && !updateCursor) return;
    if (!hasTyping && !updateCursor) return;
    socket.serializeAttachment({ ...latest,
      ...(hasTyping ? { typing: Boolean(event.typing), typingAt: event.typing ? now : 0 } : {}),
      ...(updateCursor ? { cursor: event.cursor === null ? null : { x: (event.cursor as RoomCursor).x, y: (event.cursor as RoomCursor).y }, cursorAt: now } : {}),
    } satisfies RoomSocketAttachment);
    this.broadcastCollaborationPresence(authorized, latest.collaboration.roomId);
    await this.scheduleMaintenanceAlarm();
  }

  /** Binding-only read. The Worker checks the room audience before and after this RPC. */
  async readRunEvents(identity: RunRoomIdentity, after: number, limit = 256): Promise<RunRoomReplay> {
    const ownerId = typeof identity.ownerId === "string" ? identity.ownerId.trim().toLowerCase() : "";
    if (!ownerId || ownerId.length > 320 || !isValidSessionId(identity.sessionId) ||
      typeof identity.runId !== "string" || !identity.runId || identity.runId.length > 200 ||
      !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("Invalid run replay request.");
    }
    // Reading an absent or different room must not create/adopt its identity.
    const room = this.ctx.storage.sql.exec<{ owner_id: string; session_id: string }>(
      "SELECT owner_id, session_id FROM room_identity WHERE singleton = 1",
    ).toArray()[0];
    if (!room) return { runId: identity.runId, after, oldest: 0, latest: 0, nextCursor: 0, hasMore: false, gap: after > 0, frames: [] };
    if (room.owner_id !== ownerId || room.session_id !== identity.sessionId) throw new Error("Room identity does not match.");
    const bounds = this.ctx.storage.sql.exec<{ oldest: number | null; latest: number | null }>(
      "SELECT MIN(sequence) AS oldest, MAX(sequence) AS latest FROM room_run_events WHERE run_id = ?", identity.runId,
    ).toArray()[0];
    const retained = this.ctx.storage.sql.exec<{ oldest: number | null }>(
      "SELECT MIN(sequence) AS oldest FROM room_run_events",
    ).toArray()[0]?.oldest ?? 0;
    const oldest = bounds?.oldest ?? 0;
    const latest = bounds?.latest ?? 0;
    const reset = after > latest;
    const rows = this.ctx.storage.sql.exec<RunEventRow>(
      "SELECT sequence, event_id, run_id, body, created_at FROM room_run_events WHERE sequence > ? AND run_id = ? ORDER BY sequence ASC LIMIT ?",
      reset ? 0 : after, identity.runId, limit + 1,
    ).toArray();
    let invalid = false;
    const frames: RunRoomFrame[] = [];
    for (const row of rows.slice(0, limit)) {
      let event: unknown;
      try { event = JSON.parse(row.body); } catch { invalid = true; continue; }
      if (row.run_id !== identity.runId || !isRunRoomEvent(event)) { invalid = true; continue; }
      frames.push({ type: "run:event", sequence: row.sequence, eventId: row.event_id,
        runId: identity.runId, createdAt: row.created_at, event });
    }
    return {
      runId: identity.runId, after, oldest, latest,
      nextCursor: rows.length ? rows[Math.min(rows.length, limit) - 1]!.sequence : reset ? latest : after,
      hasMore: rows.length > limit,
      // Global retention can remove a run's prefix or its entire journal. Never imply completeness.
      gap: invalid || reset || (retained > 1 && after < retained - 1), frames,
    };
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

  /** Binding-only source checkpoint. A different approved envelope cannot adopt this job. */
  async openRunJournal(identity: RunRoomIdentity, journal: RunJournalIdentity): Promise<number> {
    this.validateRunJournal(identity, journal);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO room_run_journals (job_id, run_id, generation, acknowledged_through, source_sequence, event_count, character_count) VALUES (?, ?, ?, 0, 0, 0, 0)",
      journal.jobId, identity.runId, journal.generation,
    );
    return this.runJournal(identity, journal).acknowledged_through;
  }

  /** Redacted events and the source acknowledgment commit together before fanout. */
  async appendRunJournalBatch(identity: RunRoomIdentity, batch: RunJournalBatch): Promise<number> {
    this.validateRunJournal(identity, batch);
    if (!Number.isSafeInteger(batch.sourceSequence) || batch.sourceSequence < 0 || batch.sourceSequence > MAX_RUN_JOURNAL_FRAMES ||
      !Number.isSafeInteger(batch.acknowledgedThrough) || batch.acknowledgedThrough < 0 || batch.acknowledgedThrough > batch.sourceSequence ||
      !Array.isArray(batch.events) || batch.events.length > MAX_RUN_JOURNAL_BATCH_EVENTS ||
      JSON.stringify(batch.events).length > MAX_RUN_JOURNAL_BATCH_CHARS) throw new Error("Invalid journal batch.");
    const ids = new Set<string>();
    const prepared = await Promise.all(batch.events.map(async ({ eventId, event }) => {
      if (!VIEWER_ID.test(eventId) || ids.has(eventId) || !isRunRoomEvent(event) || event.kind !== "terminal") throw new Error("Invalid journal event.");
      ids.add(eventId);
      const body = JSON.stringify(event);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return { eventId, event, body, digest };
    }));
    const frames: RunRoomFrame[] = [];
    const ack = this.ctx.storage.transactionSync(() => {
      const journal = this.runJournal(identity, batch);
      let characters = journal.character_count;
      for (const item of prepared) {
        const receipt = this.ctx.storage.sql.exec<{ digest: string; sequence: number }>(
          "SELECT digest, sequence FROM room_run_journal_receipts WHERE job_id = ? AND event_id = ?", batch.jobId, item.eventId,
        ).toArray()[0];
        if (receipt) {
          if (receipt.digest !== item.digest) throw new Error("Journal event does not match its durable receipt.");
          continue;
        }
        characters += item.event.data.length;
        if (batch.sourceSequence <= journal.acknowledged_through || journal.event_count + frames.length >= MAX_RUN_JOURNAL_EVENTS || characters > MAX_RUN_JOURNAL_CHARS) {
          throw new Error("Journal source is stale or exceeds its event bound.");
        }
        const createdAt = Date.now();
        const row = this.ctx.storage.sql.exec<{ sequence: number }>(
          "INSERT INTO room_run_events (event_id, run_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
          item.eventId, identity.runId, item.body, createdAt,
        ).toArray()[0];
        if (!row) throw new Error("Journal event was not persisted.");
        this.ctx.storage.sql.exec(
          "INSERT INTO room_run_journal_receipts (job_id, event_id, digest, sequence) VALUES (?, ?, ?, ?)",
          batch.jobId, item.eventId, item.digest, row.sequence,
        );
        frames.push({ type: "run:event", sequence: row.sequence, eventId: item.eventId, runId: identity.runId, createdAt, event: item.event });
      }
      const acknowledgedThrough = Math.max(journal.acknowledged_through, batch.acknowledgedThrough);
      this.ctx.storage.sql.exec(
        "UPDATE room_run_journals SET acknowledged_through = ?, source_sequence = ?, event_count = ?, character_count = ? WHERE job_id = ?",
        acknowledgedThrough, Math.max(journal.source_sequence, batch.sourceSequence), journal.event_count + frames.length, characters, batch.jobId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM room_run_events WHERE sequence IN (SELECT sequence FROM room_run_events ORDER BY sequence DESC LIMIT -1 OFFSET ?)", MAX_RUN_ROOM_EVENTS,
      );
      return acknowledgedThrough;
    });
    for (const frame of frames) this.broadcast(frame);
    return ack;
  }

  private validateRunJournal(identity: RunRoomIdentity, journal: RunJournalIdentity): void {
    const ownerId = typeof identity.ownerId === "string" ? identity.ownerId.trim().toLowerCase() : "";
    if (!ownerId || ownerId.length > 320 || !isValidSessionId(identity.sessionId) ||
      typeof identity.runId !== "string" || !identity.runId || identity.runId.length > 200 ||
      !JOURNAL_ID.test(journal.jobId) || !JOURNAL_ID.test(journal.generation)) throw new Error("Invalid journal identity.");
    if (!this.bindIdentity(ownerId, identity.sessionId)) throw new Error("Room identity does not match.");
  }

  private runJournal(identity: RunRoomIdentity, journal: RunJournalIdentity): RunJournalRow {
    const row = this.ctx.storage.sql.exec<RunJournalRow>("SELECT run_id, generation, acknowledged_through, source_sequence, event_count, character_count FROM room_run_journals WHERE job_id = ?", journal.jobId).toArray()[0];
    if (!row || row.run_id !== identity.runId || row.generation !== journal.generation) throw new Error("Journal identity does not match the approved run generation.");
    return row;
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) {
      socket.close(1008, "Room identity is unavailable.");
      return;
    }
    if (attachment.collaboration) return this.collaborationMessage(socket, attachment, raw);
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
      const hasTyping = typeof event.typing === "boolean";
      const hasCursor = event.type === "client_presence" && Object.hasOwn(event, "cursor");
      if ((!hasTyping && !hasCursor) || (hasCursor && event.cursor !== null && !isCursor(event.cursor))) {
        this.send(socket, { type: "error", error: "Invalid room presence." });
        return;
      }
      const now = Date.now();
      const updateCursor = hasCursor && (event.cursor === null || now - attachment.cursorAt >= CURSOR_INTERVAL_MS);
      if (!hasTyping && !updateCursor) return;
      socket.serializeAttachment({
        ...attachment,
        ...(hasTyping ? { typing: Boolean(event.typing), typingAt: event.typing ? now : 0 } : {}),
        ...(updateCursor ? { cursor: event.cursor === null ? null : { x: (event.cursor as RoomCursor).x, y: (event.cursor as RoomCursor).y }, cursorAt: now } : {}),
      } satisfies RoomSocketAttachment);
      this.broadcastPresence();
      await this.scheduleMaintenanceAlarm();
      return;
    }

    if (attachment.readOnly) {
      this.send(socket, { type: "error", error: "This run view is read only." });
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
    await this.refreshCollaborationPresence();
    this.broadcastPresence();
    this.pruneRelayStreams();
    await this.scheduleMaintenanceAlarm();
  }

  async webSocketError(): Promise<void> {
    await this.refreshCollaborationPresence();
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
      const current = attachmentFor(socket);
      if (current?.cursor && current.cursorAt + CURSOR_TTL_MS <= now) {
        socket.serializeAttachment({ ...current, cursor: null, cursorAt: 0 } satisfies RoomSocketAttachment);
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
    await this.refreshCollaborationPresence();
    this.broadcastPresence();
    await this.scheduleMaintenanceAlarm();
  }

  private viewers(): RoomViewer[] {
    const now = Date.now();
    const unique = new Map<string, RoomViewer & { cursorAt: number }>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.collaboration) continue;
      const current = unique.get(attachment.viewerId);
      const cursor = attachment.cursor && attachment.cursorAt + CURSOR_TTL_MS > now ? attachment.cursor : null;
      unique.set(attachment.viewerId, {
        viewerId: attachment.viewerId,
        joinedAt: Math.min(current?.joinedAt ?? attachment.joinedAt, attachment.joinedAt),
        typing: Boolean(current?.typing || (attachment.typing && attachment.typingAt + TYPING_TTL_MS > now)),
        label: attachment.viewerLabel,
        cursor: current && current.cursorAt > attachment.cursorAt ? current.cursor : cursor,
        cursorAt: Math.max(current?.cursorAt ?? 0, attachment.cursorAt),
      });
    }
    return [...unique.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(({ cursorAt: _cursorAt, ...viewer }) => viewer);
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
    const runId = attachmentFor(socket)?.runId;
    const rows = (runId
      ? this.ctx.storage.sql.exec<RunEventRow>(
          "SELECT sequence, event_id, run_id, body, created_at FROM room_run_events WHERE sequence > ? AND run_id = ? ORDER BY sequence ASC LIMIT ?",
          cursor, runId, MAX_RUN_ROOM_EVENTS,
        )
      : this.ctx.storage.sql.exec<RunEventRow>(
          "SELECT sequence, event_id, run_id, body, created_at FROM room_run_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
          cursor, MAX_RUN_ROOM_EVENTS,
        )).toArray();
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
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment?.collaboration) continue;
      if (attachment?.readOnly && isRecord(event) && event.type !== "presence" &&
        (event.type !== "run:event" || event.runId !== attachment.runId)) continue;
      this.send(socket, event);
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", viewers: this.viewers() });
  }

  private async refreshCollaborationPresence(): Promise<void> {
    const sockets = await this.authorizedCollaborationSockets();
    const roomId = sockets[0] && attachmentFor(sockets[0])?.collaboration?.roomId;
    if (roomId) this.broadcastCollaborationPresence(sockets, roomId);
  }

  private async scheduleMaintenanceAlarm(): Promise<void> {
    const attachments = this.ctx.getWebSockets()
      .filter((socket) => socket.readyState === 1)
      .map(attachmentFor)
      .filter((attachment): attachment is RoomSocketAttachment => attachment !== null);
    const expiries = attachments.flatMap((attachment) => [
      ...(attachment.collaboration ? [Date.now() + MEMBERSHIP_RECHECK_MS] : []),
      ...(attachment.typing ? [attachment.typingAt + TYPING_TTL_MS] : []),
      ...(attachment.cursor ? [attachment.cursorAt + CURSOR_TTL_MS] : []),
    ]);
    const streams = this.ctx.storage.sql.exec<{ [key: string]: string | number; updated_at: number }>(
      "SELECT updated_at FROM room_streams WHERE status = 'streaming'",
    ).toArray();
    expiries.push(...streams.map((stream) => stream.updated_at + STREAM_TTL_MS));
    const expiry = expiries.reduce((earliest, item) => Math.min(earliest, item), Infinity);
    if (Number.isFinite(expiry)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, expiry));
    else await this.ctx.storage.deleteAlarm();
  }
}
