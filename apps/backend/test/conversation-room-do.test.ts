import { describe, expect, it, vi } from "vitest";
import { ConversationRoom } from "../src/conversation-room-do.js";
import type { Env } from "../src/env.js";

class RoomSql {
  messages = new Map<string, { message_id: string; viewer_id: string; body: string; created_at: number }>();
  streams = new Map<string, { stream_id: string; viewer_id: string; body: string; status: string; created_at: number; updated_at: number }>();

  exec<T>(sql: string, ...values: unknown[]) {
    const statement = sql.replace(/\s+/g, " ").trim();
    let rows: unknown[] = [];
    if (statement.startsWith("SELECT message_id FROM room_messages")) {
      const row = this.messages.get(String(values[0]));
      rows = row ? [{ message_id: row.message_id }] : [];
    } else if (statement.startsWith("SELECT message_id, viewer_id, body, created_at FROM room_messages")) {
      rows = [...this.messages.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Number(values[0] ?? 200));
    } else if (statement.startsWith("INSERT INTO room_messages")) {
      const [messageId, viewerId, body, createdAt] = values as [string, string, string, number];
      this.messages.set(messageId, { message_id: messageId, viewer_id: viewerId, body, created_at: createdAt });
    } else if (statement.startsWith("DELETE FROM room_messages")) {
      const keep = Number(values[0]);
      const ordered = [...this.messages.values()].sort((a, b) => b.created_at - a.created_at);
      for (const row of ordered.slice(keep)) this.messages.delete(row.message_id);
    } else if (statement.startsWith("INSERT INTO room_streams")) {
      const [streamId, viewerId, createdAt, updatedAt] = values as [string, string, number, number];
      this.streams.set(streamId, {
        stream_id: streamId, viewer_id: viewerId, body: "", status: "streaming",
        created_at: createdAt, updated_at: updatedAt,
      });
    } else if (statement.startsWith("SELECT stream_id, viewer_id, body, status, updated_at FROM room_streams WHERE stream_id")) {
      const row = this.streams.get(String(values[0]));
      rows = row ? [row] : [];
    } else if (statement.startsWith("SELECT stream_id, viewer_id, body, status, updated_at FROM room_streams WHERE status")) {
      const cutoff = Number(values[0]);
      rows = [...this.streams.values()]
        .filter((row) => row.status === "streaming" && row.updated_at >= cutoff)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 5);
    } else if (statement.startsWith("SELECT updated_at FROM room_streams WHERE status")) {
      rows = [...this.streams.values()]
        .filter((row) => row.status === "streaming")
        .map((row) => ({ updated_at: row.updated_at }));
    } else if (statement.startsWith("UPDATE room_streams SET body")) {
      const [body, updatedAt, streamId, viewerId] = values as [string, number, string, string];
      const row = this.streams.get(streamId);
      if (row?.viewer_id === viewerId && row.status === "streaming") {
        row.body = body;
        row.updated_at = updatedAt;
      }
    } else if (statement.startsWith("UPDATE room_streams SET status = 'failed'")) {
      const [updatedAt, cutoff] = values as [number, number];
      for (const row of this.streams.values()) {
        if (row.status === "streaming" && row.updated_at <= cutoff) {
          row.status = "failed";
          row.updated_at = updatedAt;
        }
      }
    } else if (statement.startsWith("UPDATE room_streams SET status = ?")) {
      const [status, updatedAt, streamId, viewerId] = values as [string, number, string, string];
      const row = this.streams.get(streamId);
      if (row?.viewer_id === viewerId && row.status === "streaming") {
        row.status = status;
        row.updated_at = updatedAt;
      }
    }
    return { toArray: () => rows as T[] };
  }
}

class FakeSocket {
  readyState = 1;
  attachment: unknown;
  sent: string[] = [];
  close = vi.fn();
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value: string) { this.sent.push(value); }
  events() { return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>); }
}

function socket(viewerId: string) {
  const value = new FakeSocket();
  value.serializeAttachment({
    ownerId: "owner@example.test",
    sessionId: "default",
    viewerId,
    joinedAt: Date.now(),
    typing: false,
    typingAt: 0,
  });
  return value;
}

function roomFixture() {
  const sql = new RoomSql();
  const sockets = [socket("11111111-1111-4111-8111-111111111111"), socket("22222222-2222-4222-8222-222222222222")];
  const ctx = {
    storage: {
      sql,
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
    getWebSockets: () => sockets as unknown as WebSocket[],
    acceptWebSocket: vi.fn(),
  } as unknown as DurableObjectState;
  const room = new ConversationRoom(ctx, {} as Env);
  return { room, sql, sockets, ctx };
}

describe("ConversationRoom", () => {
  it("persists room messages and stream deltas before broadcasting them to every viewer", async () => {
    const { room, sql, sockets } = roomFixture();
    const [owner, other] = sockets;
    const streamId = "33333333-3333-4333-8333-333333333333";

    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({
      type: "message", messageId: "message-1", text: "Hello from the room",
    }));
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId }));
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "A live " }));
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "response" }));

    expect(sql.messages.get("message-1")?.body).toBe("Hello from the room");
    expect(sql.streams.get(streamId)?.body).toBe("A live response");
    expect(owner!.events().some((event) => event.type === "message" && event.messageId === "message-1")).toBe(true);
    expect(other!.events().some((event) => event.type === "message" && event.messageId === "message-1")).toBe(true);
    expect(other!.events().some((event) => event.type === "stream:delta" && event.text === "A live response")).toBe(true);

    const restarted = new ConversationRoom((room as unknown as { ctx: DurableObjectState }).ctx, {} as Env);
    expect((restarted as unknown as { recentMessages(): Array<{ messageId: string; text: string }> }).recentMessages())
      .toContainEqual(expect.objectContaining({ messageId: "message-1", text: "Hello from the room" }));
    expect((restarted as unknown as { activeStreams(): Array<{ streamId: string; text: string }> }).activeStreams())
      .toContainEqual({ streamId, viewerId: "11111111-1111-4111-8111-111111111111", text: "A live response" });
  });

  it("limits stream writes to their originating viewer and expires typing presence", async () => {
    const { room, sql, sockets } = roomFixture();
    const [owner, other] = sockets;
    const streamId = "44444444-4444-4444-8444-444444444444";
    await room.webSocketMessage(owner as unknown as WebSocket, JSON.stringify({ type: "stream:start", streamId }));
    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "stream:delta", streamId, delta: "forged" }));
    expect(sql.streams.get(streamId)?.body).toBe("");

    await room.webSocketMessage(other as unknown as WebSocket, JSON.stringify({ type: "typing", typing: true }));
    expect(other!.events().at(-1)).toMatchObject({
      type: "presence",
      viewers: expect.arrayContaining([
        expect.objectContaining({ viewerId: "11111111-1111-4111-8111-111111111111", typing: false }),
        expect.objectContaining({ viewerId: "22222222-2222-4222-8222-222222222222", typing: true }),
      ]),
    });
    expect((room as unknown as { ctx: DurableObjectState }).ctx.storage.setAlarm).toHaveBeenCalled();

    const expiredAttachment = other!.deserializeAttachment() as {
      ownerId: string; sessionId: string; viewerId: string; joinedAt: number; typing: boolean; typingAt: number;
    };
    other!.serializeAttachment({ ...expiredAttachment, typingAt: Date.now() - 6_000 });
    await room.alarm();
    expect(other!.deserializeAttachment()).toMatchObject({ typing: false, typingAt: 0 });
  });
});
