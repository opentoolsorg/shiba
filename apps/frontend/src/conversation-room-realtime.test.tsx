// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationRoomRealtime } from "./conversation-room-realtime";

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  readonly url: string;
  readonly sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(url: string | URL) { this.url = String(url); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(raw: string) { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useConversationRoomRealtime", () => {
  it("shows room presence and fans out user messages and live agent text", () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const onMessage = vi.fn();
    const initial = {
      sessionId: "default",
      enabled: true,
      typingText: "",
      messages: [] as Array<{ id: string; role: string; metadata?: unknown; parts: Array<{ type: string; text: string }> }>,
      onMessage,
    };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: initial });
    const socket = sockets[0]!;
    expect(new URL(socket.url).pathname).toBe("/api/sessions/default/realtime");
    expect(new URL(socket.url).searchParams.get("viewer")).toBe(hook.result.current.viewerId);

    act(() => socket.open());
    expect(hook.result.current.status).toBe("connected");
    act(() => socket.receive({
      type: "snapshot",
      viewers: [
        { viewerId: hook.result.current.viewerId, joinedAt: 1, typing: false },
        { viewerId: "remote-viewer", joinedAt: 2, typing: true },
      ],
      streams: [],
      messages: [{
        messageId: "history-message", viewerId: "remote-viewer", role: "user",
        text: "Loaded from room history", createdAt: 1,
      }],
    }));
    expect(hook.result.current.viewers).toHaveLength(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "history-message", text: "Loaded from room history",
    }));

    act(() => socket.receive({
      type: "message", messageId: "remote-message", viewerId: "remote-viewer",
      role: "user", text: "Hi there", createdAt: 2,
    }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "remote-message", text: "Hi there" }));

    let streamId = "";
    const streamText = "A streaming answer ".repeat(500);
    act(() => { streamId = hook.result.current.startStream(); });
    const viewerId = hook.result.current.viewerId;
    hook.rerender({
      ...initial,
      messages: [
        { id: "user-message", role: "user", metadata: { shibaRoomViewerId: viewerId }, parts: [{ type: "text", text: "Question" }] },
        { id: "assistant-message", role: "assistant", parts: [{ type: "text", text: streamText }] },
      ],
    });
    act(() => hook.result.current.finishStream(streamId, "complete"));
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "stream:start", streamId }),
      expect.objectContaining({ type: "message", messageId: "user-message", text: "Question" }),
      expect.objectContaining({ type: "stream:end", streamId, status: "complete" }),
    ]));
    const deltas = socket.sent.filter((event) => event.type === "stream:delta");
    expect(deltas.map((event) => event.delta).join("")).toBe(streamText.slice(0, 50_000));
    expect(deltas.every((event) => String(event.delta).length <= 1_000)).toBe(true);

    act(() => socket.receive({ type: "stream:start", streamId: "remote-stream", viewerId: "remote-viewer" }));
    act(() => socket.receive({ type: "stream:delta", streamId: "remote-stream", viewerId: "remote-viewer", text: "Live reply" }));
    expect(hook.result.current.remoteStream).toEqual({ streamId: "remote-stream", viewerId: "remote-viewer", text: "Live reply" });
    act(() => socket.receive({ type: "stream:end", streamId: "remote-stream", viewerId: "remote-viewer", status: "complete" }));
    expect(hook.result.current.remoteStream).toBeNull();

    hook.unmount();
  });

  it("replays the full assistant text when an active stream reconnects", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const initial = {
      sessionId: "default", enabled: true, typingText: "", onMessage: vi.fn(),
      messages: [] as Array<{ id: string; role: string; parts: Array<{ type: string; text: string }> }>,
    };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: initial });
    act(() => sockets[0]!.open());
    let streamId = "";
    act(() => { streamId = hook.result.current.startStream(); });
    const message = (text: string) => ({ id: "assistant", role: "assistant", parts: [{ type: "text", text }] });
    hook.rerender({ ...initial, messages: [message("Before disconnect. ")] });
    act(() => sockets[0]!.close());
    hook.rerender({ ...initial, messages: [message("Before disconnect. After reconnect.")] });
    act(() => vi.advanceTimersByTime(1_000));
    act(() => sockets[1]!.open());
    expect(sockets[1]!.sent[0]).toEqual({ type: "stream:start", streamId });
    expect(sockets[1]!.sent.filter((event) => event.type === "stream:delta").map((event) => event.delta).join(""))
      .toBe("Before disconnect. After reconnect.");
    act(() => hook.result.current.finishStream(streamId, "complete"));
    expect(sockets[1]!.sent.at(-1)).toEqual({ type: "stream:end", streamId, status: "complete" });
    hook.unmount();
  });

  it("publishes and clears typing state as the composer changes", () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const initial = { sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn() };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: initial });
    act(() => sockets[0]!.open());
    hook.rerender({ ...initial, typingText: "Draft in progress" });
    expect(sockets[0]!.sent).toContainEqual({ type: "typing", typing: true });
    hook.rerender(initial);
    expect(sockets[0]!.sent).toContainEqual({ type: "typing", typing: false });
    hook.unmount();
  });
});
