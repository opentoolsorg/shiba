import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRoom } from "../src/conversation-room-do.js";
import type { Env } from "../src/env.js";
import { authenticatedRoomViewerId, createRunRoomPublisher, MAX_RUN_ROOM_EVENTS, RUN_ROOM_RPC_TIMEOUT_MS, type RunRoomEvent, type RunRoomFrame } from "../src/run-room-events.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const socket = {
    readyState: 1,
    events: [] as Array<Record<string, unknown>>,
    attachment: { ownerId: "owner@example.test", sessionId: "default", viewerId: crypto.randomUUID(), joinedAt: 1, typing: false, typingAt: 0 },
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value: typeof this.attachment) { this.attachment = value; },
    send(raw: string) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame.type === "run:event") {
        expect(db.prepare("SELECT sequence FROM room_run_events WHERE sequence = ?").get(Number(frame.sequence)))
          .toBeDefined();
      }
      this.events.push(frame);
    },
    close: vi.fn(),
  };
  const ctx = {
    storage: {
      sql: {
        exec<T>(sql: string, ...values: SQLInputValue[]) {
          const rows = db.prepare(sql).all(...values);
          return { toArray: () => rows as T[] };
        },
      },
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
    getWebSockets: () => socket.readyState === 1 ? [socket] : [],
  } as unknown as DurableObjectState;
  const room = new ConversationRoom(ctx, {} as Env);
  const identity = { ownerId: "owner@example.test", sessionId: "default", runId: "run-approved" };
  return { room, ctx, socket, db, identity };
}

describe("server run room streams", () => {
  it("persists ordered frames, deduplicates uncertain retries and replays disconnected output after a restart", async () => {
    const { room, ctx, socket, identity } = fixture();
    const eventId = crypto.randomUUID();
    expect(await room.appendRunEvent(identity, eventId, { kind: "terminal", stream: "stdout", data: "before\n" })).toBe(1);
    expect(await room.appendRunEvent(identity, eventId, { kind: "terminal", stream: "stdout", data: "before\n" })).toBe(1);
    expect(socket.events.filter((event) => event.type === "run:event")).toHaveLength(1);
    socket.readyState = 3;
    await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "terminal", stream: "stderr", data: "during\n" });
    await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "status", status: "completed" });
    socket.readyState = 1;
    socket.events = [];
    const restarted = new ConversationRoom(ctx, {} as Env);
    await restarted.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "subscribe", after: 1 }));
    expect(socket.events.filter((event) => event.type === "run:event").map((event) => event.sequence)).toEqual([2, 3]);
    expect(socket.events.at(-1)).toEqual({ type: "run:replay_complete", sequence: 3 });
  });

  it("refuses browser output injection and mismatched owners without persistence or fanout", async () => {
    const { room, socket, db, identity } = fixture();
    await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "status", status: "running" });
    socket.events = [];
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "run:event", event: { kind: "terminal", stream: "stdout", data: "forged" },
    }));
    await expect(room.appendRunEvent({ ...identity, ownerId: "attacker@example.test" }, crypto.randomUUID(), {
      kind: "status", status: "completed",
    })).rejects.toThrow("Room identity");
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()).toMatchObject({ count: 1 });
    expect(socket.events).toEqual([{ type: "error", error: "Unsupported room event." }]);
  });

  it("handles client_presence with server labels, bounded cursors, throttling and expiry", async () => {
    vi.useFakeTimers();
    try {
      const { room, socket, identity } = fixture();
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
        type: "client_presence", typing: true, cursor: { x: 0.25, y: 0.75 },
        viewerId: "forged", label: "Administrator", ownerId: "other@example.test",
      }));
      expect(socket.events.at(-1)).toMatchObject({ type: "presence", viewers: [{
        viewerId: socket.attachment.viewerId, label: identity.ownerId, typing: true, cursor: { x: 0.25, y: 0.75 },
      }] });
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: 0.9, y: 0.9 } }));
      expect(socket.events.at(-1)).toMatchObject({ viewers: [{ cursor: { x: 0.25, y: 0.75 } }] });
      for (const cursor of [{ x: -1, y: 0 }, { x: 0, y: 1.1 }, { x: "0", y: 0 }]) {
        await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor }));
        expect(socket.events.at(-1)).toMatchObject({ type: "error", error: "Invalid room presence." });
      }
      vi.advanceTimersByTime(100);
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "client_presence", cursor: { x: 1, y: 0 } }));
      expect(socket.events.at(-1)).toMatchObject({ viewers: [{ cursor: { x: 1, y: 0 } }] });
      vi.advanceTimersByTime(15_001);
      await room.alarm();
      expect(socket.events.at(-1)).toMatchObject({ viewers: [{ label: identity.ownerId, cursor: null, typing: false }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists prompt_input as peer chat with server attribution and no command dispatch", async () => {
    const { room, socket, db } = fixture();
    const prompt = { type: "prompt_input", messageId: "peer-chat-1", text: " Peer note only ", viewerId: "forged" };
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(prompt));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(prompt));
    expect(db.prepare("SELECT viewer_id,body FROM room_messages").all()).toEqual([
      expect.objectContaining({ viewer_id: socket.attachment.viewerId, body: "Peer note only" }),
    ]);
    expect(socket.events).toEqual([{ type: "message", messageId: "peer-chat-1", viewerId: socket.attachment.viewerId, role: "user", text: "Peer note only", createdAt: expect.any(Number) }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()).toMatchObject({ count: 0 });
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ ...prompt, messageId: "bad", text: " " }));
    expect(socket.events.at(-1)).toMatchObject({ type: "error", error: "Invalid room message." });
  });

  it("limits a read-only run socket to its exact run and rejects peer chat and relay writes", async () => {
    const { room, socket, identity, db } = fixture();
    Object.assign(socket.attachment, { readOnly: true, runId: identity.runId });
    await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: "visible" });
    await room.appendRunEvent({ ...identity, runId: "another-run" }, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: "private-other-run" });
    expect(socket.events.filter((event) => event.type === "run:event")).toHaveLength(1);
    socket.events = [];
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "subscribe", after: 0 }));
    expect(socket.events.filter((event) => event.type === "run:event").map((event) => event.runId)).toEqual([identity.runId]);
    for (const event of [
      { type: "prompt_input", messageId: "write", text: "execute" },
      { type: "message", messageId: "write", text: "execute" },
      { type: "stream:start", streamId: crypto.randomUUID() },
    ]) {
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(event));
      expect(socket.events.at(-1)).toMatchObject({ type: "error", error: "This run view is read only." });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_messages").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_streams").get()).toMatchObject({ count: 0 });
  });

  it("shows Alice and Bob with verified labels despite a reused client tab marker and spoofed presence", async () => {
    const { room, ctx, socket, identity, db } = fixture();
    identity.ownerId = "alice@example.test";
    const tab = crypto.randomUUID();
    const aliceId = await authenticatedRoomViewerId(identity.ownerId, tab);
    const bobId = await authenticatedRoomViewerId("bob@example.test", tab);
    expect(aliceId).not.toBe(bobId);
    expect(await authenticatedRoomViewerId("BOB@example.test", tab)).toBe(bobId);
    Object.assign(socket.attachment, { ownerId: identity.ownerId, actorId: identity.ownerId, viewerId: aliceId, readOnly: true, runId: identity.runId });
    const bob = { ...socket, events: [] as Array<Record<string, unknown>>, attachment: { ...socket.attachment, actorId: "bob@example.test", viewerId: bobId } };
    ctx.getWebSockets = () => [socket, bob] as unknown as WebSocket[];
    await room.webSocketMessage(bob as unknown as WebSocket, JSON.stringify({ type: "client_presence", typing: true, label: identity.ownerId, actorId: identity.ownerId, viewerId: aliceId, cursor: { x: 0.5, y: 0.25 } }));
    expect(socket.events.at(-1)).toMatchObject({ type: "presence", viewers: expect.arrayContaining([
      expect.objectContaining({ viewerId: aliceId, label: identity.ownerId }),
      expect.objectContaining({ viewerId: bobId, label: "bob@example.test", cursor: { x: 0.5, y: 0.25 } }),
    ]) });
    await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: "shared read-only output" });
    for (const viewer of [socket, bob]) {
      expect(viewer.events.some((event) => event.type === "run:event")).toBe(true);
      await room.webSocketMessage(viewer as unknown as WebSocket, JSON.stringify({ type: "prompt_input", messageId: "no-write", text: "start a task" }));
      expect(viewer.events.at(-1)).toMatchObject({ type: "error", error: "This run view is read only." });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_messages").get()).toMatchObject({ count: 0 });
  });

  it("binds browser relay streams to server connection ids even when a viewer id is spoofed", async () => {
    const { room, socket, db } = fixture();
    const streamId = crypto.randomUUID();
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "original" }));
    const lease = socket.events.find((frame) => frame.type === "stream:lease");
    const other = { ...socket, attachment: { ...socket.attachment, connectionId: crypto.randomUUID() }, events: [] as Array<Record<string, unknown>> };
    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId }));
    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "forged" }));
    expect(db.prepare("SELECT body FROM room_streams WHERE stream_id = ?").get(streamId)).toMatchObject({ body: "original" });
    expect(other.events).toContainEqual({ type: "error", error: "Stream belongs to another connection." });
    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId, resumeToken: lease?.resumeToken }));
    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "resumed" }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "stale writer" }));
    expect(db.prepare("SELECT body FROM room_streams WHERE stream_id = ?").get(streamId)).toMatchObject({ body: "resumed" });
  });

  it("bounds relay stream records and removes their expired ownership records", async () => {
    const { room, socket, db } = fixture();
    for (let index = 0; index < 205; index++) {
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId: crypto.randomUUID() }));
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_streams").get()).toMatchObject({ count: 200 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_stream_owners").get()).toMatchObject({ count: 200 });
  });

  it("keeps a bounded history and reports an expired cursor explicitly", async () => {
    const { room, socket, db, identity } = fixture();
    socket.readyState = 3;
    for (let index = 0; index <= MAX_RUN_ROOM_EVENTS; index++) {
      await room.appendRunEvent(identity, crypto.randomUUID(), { kind: "terminal", stream: "stdout", data: `${index}\n` });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()).toMatchObject({ count: MAX_RUN_ROOM_EVENTS });
    socket.readyState = 1;
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "subscribe", after: 0 }));
    expect(socket.events[0]).toMatchObject({ type: "run:replay_gap", oldest: 2, latest: MAX_RUN_ROOM_EVENTS + 1 });
    expect(socket.events.filter((event) => event.type === "run:event")).toHaveLength(MAX_RUN_ROOM_EVENTS);
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "subscribe", after: -1 }));
    expect(socket.events.at(-1)).toMatchObject({ type: "error", error: "Invalid replay cursor." });
  });

  it("redacts secrets spanning terminal chunks and preserves stdout, stderr and diff order", async () => {
    const frames: RunRoomEvent[] = [];
    const appendRunEvent = vi.fn(async (_identity: unknown, _eventId: string, event: RunRoomEvent) => {
      frames.push(event);
      return frames.length;
    });
    const env = { ConversationRoom: { getByName: () => ({ appendRunEvent }) } } as unknown as Env;
    const publisher = createRunRoomPublisher(env, { ownerId: "owner", sessionId: "default", runId: "run" }, (text) => text.replaceAll("private-session-secret", "[redacted]"));
    publisher.terminal("stdout", "private-session-");
    publisher.terminal("stdout", "secret\n");
    publisher.terminal("stderr", "ghp_a1234567890\n");
    await publisher.diff("x".repeat(8_100));
    publisher.terminal("stdout", "final partial line");
    await publisher.flush();
    expect(JSON.stringify(frames)).not.toContain("private-session-secret");
    expect(JSON.stringify(frames)).not.toContain("ghp_a1234567890");
    expect(frames.slice(0, 2)).toEqual([
      { kind: "terminal", stream: "stdout", data: "[redacted]\n" },
      { kind: "terminal", stream: "stderr", data: "[redacted]\n" },
    ]);
    expect(frames.filter((frame) => frame.kind === "diff").map((frame) => frame.data).join("")).toBe("x".repeat(8_100));
    expect(frames.at(-1)).toEqual({ kind: "terminal", stream: "stdout", data: "final partial line" });
  });

  it("retries a lost append response with the same event identity", async () => {
    const { room, identity, socket } = fixture();
    let lost = true;
    const appendRunEvent = vi.fn(async (input: typeof identity, id: string, event: RunRoomEvent) => {
      const sequence = await room.appendRunEvent(input, id, event);
      if (lost) { lost = false; throw new Error("response lost"); }
      return sequence;
    });
    const env = { ConversationRoom: { getByName: () => ({ appendRunEvent }) } } as unknown as Env;
    const publisher = createRunRoomPublisher(env, identity);
    await publisher.publish({ kind: "status", status: "running" });
    await publisher.flush();
    expect(appendRunEvent).toHaveBeenCalledTimes(2);
    expect(socket.events.filter((frame) => frame.type === "run:event")).toHaveLength(1);
    expect((socket.events[0] as unknown as RunRoomFrame).sequence).toBe(1);
  });

  it("pauses delivery and persists an explicit gap when both append attempts fail", async () => {
    const frames: RunRoomEvent[] = [];
    let attempts = 0;
    const appendRunEvent = vi.fn(async (_identity: unknown, _id: string, event: RunRoomEvent) => {
      if (++attempts <= 2) throw new Error("hub disconnected");
      frames.push(event);
      return frames.length;
    });
    const env = { ConversationRoom: { getByName: () => ({ appendRunEvent }) } } as unknown as Env;
    const publisher = createRunRoomPublisher(env, { ownerId: "owner", sessionId: "default", runId: "run" });
    await publisher.publish({ kind: "terminal", stream: "stdout", data: "lost\n" });
    await publisher.publish({ kind: "terminal", stream: "stdout", data: "retained\n" });
    await expect(publisher.flush()).rejects.toThrow("hub disconnected");
    expect(frames).toEqual([
      { kind: "status", status: "stream_gap", message: "Some live output could not be delivered." },
    ]);
  });

  it("bounds a hung room RPC and trips the breaker instead of blocking every queued frame", async () => {
    vi.useFakeTimers();
    try {
      const appendRunEvent = vi.fn(() => new Promise<number>(() => {}));
      const env = { ConversationRoom: { getByName: () => ({ appendRunEvent }) } } as unknown as Env;
      const publisher = createRunRoomPublisher(env, { ownerId: "owner", sessionId: "default", runId: "run" });
      for (let index = 0; index < 100; index++) void publisher.publish({ kind: "terminal", stream: "stdout", data: `${index}\n` });
      const outcome = publisher.flush().then(() => "complete", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(RUN_ROOM_RPC_TIMEOUT_MS * 4 + 1);
      expect(await outcome).toBe("Live room delivery timed out.");
      expect(appendRunEvent).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
