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
    act(() => sockets[0]!.receive({ type: "stream:lease", streamId, resumeToken: "server-resume-token" }));
    const message = (text: string) => ({ id: "assistant", role: "assistant", parts: [{ type: "text", text }] });
    hook.rerender({ ...initial, messages: [message("Before disconnect. ")] });
    act(() => sockets[0]!.close());
    hook.rerender({ ...initial, messages: [message("Before disconnect. After reconnect.")] });
    act(() => vi.advanceTimersByTime(1_000));
    act(() => sockets[1]!.open());
    expect(sockets[1]!.sent[0]).toEqual({ type: "stream:start", streamId, resumeToken: "server-resume-token" });
    expect(sockets[1]!.sent.filter((event) => event.type === "stream:delta").map((event) => event.delta).join(""))
      .toBe("Before disconnect. After reconnect.");
    act(() => hook.result.current.finishStream(streamId, "complete"));
    expect(sockets[1]!.sent).toContainEqual({ type: "stream:end", streamId, status: "complete" });
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
    expect(sockets[0]!.sent).toContainEqual({ type: "client_presence", typing: true });
    hook.rerender(initial);
    expect(sockets[0]!.sent).toContainEqual({ type: "client_presence", typing: false });
    hook.unmount();
  });

  it("resumes terminal frames at the last applied cursor without duplicates across reconnects", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const onRunEvent = vi.fn();
    const hook = renderHook(() => useConversationRoomRealtime({
      sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn(), onRunEvent,
    }));
    act(() => sockets[0]!.open());
    expect(sockets[0]!.sent).toContainEqual({ type: "subscribe", after: 0 });
    const event = (sequence: number, data: string) => ({
      type: "run:event", sequence, runId: "run", event: { kind: "terminal", stream: "stdout", data },
    });
    act(() => {
      sockets[0]!.receive(event(1, "before\n"));
      sockets[0]!.receive({ type: "run:replay_complete", sequence: 1 });
      sockets[0]!.close();
      vi.advanceTimersByTime(1_000);
      sockets[1]!.open();
    });
    expect(sockets[1]!.sent).toContainEqual({ type: "subscribe", after: 1 });
    act(() => {
      // A fresh live frame can arrive ahead of the replay response.
      sockets[1]!.receive(event(3, "after\n"));
      sockets[1]!.receive(event(2, "during\n"));
      sockets[1]!.receive(event(3, "after\n"));
      sockets[1]!.receive({ type: "run:replay_complete", sequence: 3 });
    });
    expect(onRunEvent.mock.calls.map(([frame]) => frame.sequence)).toEqual([1, 2, 3]);
    expect(onRunEvent.mock.calls.map(([frame]) => frame.event.data).join(""))
      .toBe("before\nduring\nafter\n");
    act(() => sockets[1]!.receive({ type: "run:replay_gap", oldest: 4, latest: 8 }));
    expect(hook.result.current.replayGap).toBe(true);
    hook.unmount();
  });

  it("publishes bounded cursor presence at most ten times per second and clears it on leave", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const hook = renderHook(() => useConversationRoomRealtime({ sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn() }));
    act(() => sockets[0]!.open());
    act(() => {
      hook.result.current.setCursor({ x: 0.25, y: 0.75 });
      hook.result.current.setCursor({ x: 0.9, y: 0.9 });
      hook.result.current.setCursor({ x: -1, y: 0 });
      vi.advanceTimersByTime(100);
      hook.result.current.setCursor({ x: 1, y: 0 });
      hook.result.current.setCursor(null);
    });
    expect(sockets[0]!.sent.filter((event) => Object.hasOwn(event, "cursor"))).toEqual([
      { type: "client_presence", cursor: { x: 0.25, y: 0.75 } },
      { type: "client_presence", cursor: { x: 1, y: 0 } },
      { type: "client_presence", cursor: null },
    ]);
    hook.unmount();
  });

  it("uses the authenticated server tab identity for presence without changing the reconnect nonce", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const hook = renderHook(() => useConversationRoomRealtime({ sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn(), realtimePath: "/api/slack-canvas/websocket?approval=A" }));
    const tab = new URL(sockets[0]!.url).searchParams.get("viewer");
    const assigned = "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
    act(() => {
      sockets[0]!.open();
      sockets[0]!.receive({ type: "snapshot", viewerId: assigned, viewers: [{ viewerId: assigned, label: "bob@example.test", joinedAt: 1, typing: false }], messages: [], streams: [] });
    });
    expect(hook.result.current.viewerId).toBe(assigned);
    act(() => { sockets[0]!.close(); vi.advanceTimersByTime(1_000); sockets[1]!.open(); });
    expect(new URL(sockets[1]!.url).searchParams.get("viewer")).toBe(tab);
    hook.unmount();
  });

  it("resets replay when a protected run URL changes and refuses a foreign socket origin", () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const onRunEvent = vi.fn();
    const initial = { sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn(), onRunEvent, realtimePath: "/api/slack-canvas/websocket?approval=A" };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: initial });
    act(() => {
      sockets[0]!.open();
      sockets[0]!.receive({ type: "run:event", sequence: 1, runId: "A", event: { kind: "terminal", data: "A" } });
      sockets[0]!.receive({ type: "run:replay_complete", sequence: 1 });
    });
    hook.rerender({ ...initial, realtimePath: "/api/slack-canvas/websocket?approval=B" });
    act(() => sockets[1]!.open());
    expect(new URL(sockets[1]!.url).searchParams.get("approval")).toBe("B");
    expect(sockets[1]!.sent).toContainEqual({ type: "subscribe", after: 0 });
    hook.rerender({ ...initial, realtimePath: "https://attacker.example/api/slack-canvas/websocket" });
    expect(sockets).toHaveLength(2);
    expect(hook.result.current.status).toBe("offline");
    hook.unmount();
  });

  it("ignores late frames and clears an active publisher when navigating to another session", () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string | URL) { super(url); sockets.push(this); }
    });
    const onRunEvent = vi.fn();
    const onMessage = vi.fn();
    const options = { sessionId: "default", enabled: true, typingText: "", messages: [], onMessage, onRunEvent };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: options });
    act(() => sockets[0]!.open());
    act(() => { hook.result.current.startStream("private prompt for A"); });
    hook.rerender({ ...options, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    act(() => {
      sockets[1]!.open();
      sockets[0]!.receive({ type: "message", messageId: "late-A", viewerId: "remote", text: "A private text", createdAt: 1 });
      sockets[0]!.receive({ type: "run:event", sequence: 99, runId: "run-A", event: { kind: "terminal", stream: "stdout", data: "A output" } });
      sockets[1]!.receive({ type: "run:replay_complete", sequence: 0 });
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onRunEvent).not.toHaveBeenCalled();
    expect(sockets[1]!.sent).toEqual([{ type: "subscribe", after: 0 }]);
    hook.unmount();
  });

  it("replays into a fresh wire stream when the original ownership lease response was lost", () => {
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
    let handleId = "";
    act(() => { handleId = hook.result.current.startStream(); });
    hook.rerender({ ...initial, messages: [{ id: "assistant", role: "assistant", parts: [{ type: "text", text: "complete replay" }] }] });
    act(() => { sockets[0]!.close(); vi.advanceTimersByTime(1_000); sockets[1]!.open(); });
    const start = sockets[1]!.sent.find((event) => event.type === "stream:start");
    expect(start?.streamId).not.toBe(handleId);
    expect(sockets[1]!.sent.filter((event) => event.type === "stream:delta").map((event) => event.delta).join(""))
      .toBe("complete replay");
    act(() => hook.result.current.finishStream(handleId, "complete"));
    expect(sockets[1]!.sent).toContainEqual({ type: "stream:end", streamId: start?.streamId, status: "complete" });
    hook.unmount();
  });
});
