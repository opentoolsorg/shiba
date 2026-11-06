// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCollaborationRoomRealtime } from "./collaboration-room-realtime";

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: any) => void>>();
  constructor(readonly url: string | URL) {}
  addEventListener(type: string, callback: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  send(raw: string) { this.sent.push(raw); }
  emit(type: string, event: unknown = {}) { this.listeners.get(type)?.forEach((callback) => callback(event)); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(frame: unknown) { this.emit("message", { data: JSON.stringify(frame) }); }
  close(code = 1000) { this.readyState = 3; this.emit("close", { code }); }
}

function fixture() {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal("WebSocket", class extends FakeSocket {
    constructor(url: string | URL) { super(url); sockets.push(this); }
  });
  const onRefresh = vi.fn();
  const onAccessLost = vi.fn();
  const initial = { roomId: "room-a", workspaceId: undefined as string | undefined, enabled: true, typingText: "", onRefresh, onAccessLost };
  const hook = renderHook((props) => useCollaborationRoomRealtime(props), { initialProps: initial });
  return { sockets, onRefresh, onAccessLost, initial, hook };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared collaboration room realtime", () => {
  it("publishes only normalized cursor presence at 10Hz, clears on leave and strips claimed identity", () => {
    vi.useFakeTimers();
    const { sockets, hook } = fixture(); act(() => sockets[0]!.open()); const socket = sockets[0]!; socket.sent = [];
    act(() => { for (let index = 0; index < 100; index++) hook.result.current.publishCursor({ x: .2, y: .7 }); });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: "client_presence", cursor: { x: .2, y: .7 } }]);
    act(() => { vi.advanceTimersByTime(100); hook.result.current.publishCursor({ x: .5, y: .5, actorId: "forged" } as { x: number; y: number }); hook.result.current.publishCursor(null); hook.result.current.publishCursor(null); });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: "client_presence", cursor: { x: .2, y: .7 } }, { type: "client_presence", cursor: { x: .5, y: .5 } }, { type: "client_presence", cursor: null }]);
    act(() => hook.result.current.publishCursor({ x: -1, y: .5 })); expect(socket.sent).toHaveLength(3);
  });
  it("receives bounded authenticated cursors, rejects malformed positions and clears on membership loss", () => {
    const { sockets, hook } = fixture(); act(() => sockets[0]!.open());
    const viewer = { viewerId: "11111111-1111-4111-8111-111111111111", label: "member@example.test", typing: false, cursor: { x: .25, y: .75 } };
    act(() => sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [viewer] })); expect(hook.result.current.viewers[0]?.cursor).toEqual({ x: .25, y: .75 });
    act(() => sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [{ ...viewer, cursor: { x: 100, y: .5 } }] })); expect(hook.result.current.viewers[0]?.cursor).toEqual({ x: .25, y: .75 });
    act(() => sockets[0]!.close(1008)); expect(hook.result.current.viewers).toEqual([]);
  });
  it("never sends an old workspace cursor or renders its late frame after switching", () => {
    const { sockets, hook, initial } = fixture(); act(() => sockets[0]!.open()); const oldPublish = hook.result.current.publishCursor;
    hook.rerender({ ...initial, workspaceId: `ws_${"a".repeat(24)}` }); act(() => sockets[1]!.open()); sockets[1]!.sent = [];
    act(() => { oldPublish({ x: .5, y: .5 }); sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [{ viewerId: "11111111-1111-4111-8111-111111111111", label: "old-workspace@example.test", typing: false, cursor: { x: .5, y: .5 } }] }); });
    expect(sockets[1]!.sent).toEqual([]); expect(hook.result.current.viewers).toEqual([]);
  });
  it("reloads durable content on connection and invalidation, while publishing only presence", () => {
    const { sockets, hook, onRefresh, initial } = fixture();
    const socket = sockets[0]!;
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/api/collaboration/rooms/room-a/realtime");
    expect(url.searchParams.get("viewer")).toMatch(/^[a-f0-9-]{36}$/);
    act(() => socket.open());
    expect(onRefresh).toHaveBeenCalledWith("room-a");
    expect(hook.result.current.status).toBe("connected");
    act(() => socket.receive({ type: "collaboration:snapshot", roomId: "room-a", viewers: [
      { viewerId: "11111111-1111-4111-8111-111111111111", label: "member@example.test", typing: true },
    ] }));
    expect(hook.result.current.viewers[0]?.label).toBe("member@example.test");
    expect(onRefresh).toHaveBeenCalledTimes(2);
    act(() => socket.receive({ type: "collaboration:refresh", roomId: "room-a" }));
    expect(onRefresh).toHaveBeenCalledTimes(3);
    hook.rerender({ ...initial, typingText: "Message being composed" });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: "client_presence", typing: false },
      { type: "client_presence", typing: true },
    ]);
  });

  it("reconnects and reloads authoritative HTTP state instead of assuming missed frames were replayed", () => {
    vi.useFakeTimers();
    const { sockets, hook, onRefresh } = fixture();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.close(1006));
    expect(hook.result.current.status).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(500));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1]!.open());
    expect(onRefresh.mock.calls).toEqual([["room-a"], ["room-a"]]);
  });

  it("ignores room A frames and close events after navigating to room B", () => {
    const { sockets, hook, onRefresh, onAccessLost, initial } = fixture();
    act(() => sockets[0]!.open());
    hook.rerender({ ...initial, roomId: "room-b" });
    act(() => sockets[1]!.open());
    onRefresh.mockClear();
    act(() => {
      sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-a" });
      sockets[0]!.close(1008);
      sockets[1]!.receive({ type: "collaboration:refresh", roomId: "room-a" });
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("connected");
    expect(hook.result.current.viewers).toEqual([]);
    act(() => sockets[1]!.receive({ type: "collaboration:refresh", roomId: "room-b" }));
    expect(onRefresh).toHaveBeenCalledWith("room-b");
  });

  it("forgets presence and stops reconnecting after membership revocation", () => {
    vi.useFakeTimers();
    const { sockets, hook, onAccessLost } = fixture();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.close(1008));
    expect(onAccessLost).toHaveBeenCalledWith("room-a");
    expect(hook.result.current.viewers).toEqual([]);
    expect(hook.result.current.status).toBe("offline");
    act(() => vi.advanceTimersByTime(60_000));
    expect(sockets).toHaveLength(1);
  });

  it("separates the same room identifier in two workspace scopes and ignores late previous-scope frames", () => {
    const { sockets, hook, onRefresh, onAccessLost, initial } = fixture();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [
      { viewerId: "11111111-1111-4111-8111-111111111111", label: "old-workspace@example.test", typing: true },
    ] }));
    expect(hook.result.current.viewers).toHaveLength(1);
    const workspaceId = `ws_${"a".repeat(24)}`;
    hook.rerender({ ...initial, workspaceId });
    expect(hook.result.current.viewers).toEqual([]);
    expect(new URL(sockets[1]!.url).searchParams.get("workspaceId")).toBe(workspaceId);
    onRefresh.mockClear();
    act(() => {
      sockets[0]!.receive({ type: "collaboration:refresh", roomId: "room-a" });
      sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [
        { viewerId: "11111111-1111-4111-8111-111111111111", label: "old-workspace@example.test", typing: true },
      ] });
      sockets[0]!.close(1008);
    });
    expect(hook.result.current.viewers).toEqual([]);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onAccessLost).not.toHaveBeenCalled();
    act(() => sockets[1]!.open());
    expect(onRefresh).toHaveBeenCalledWith("room-a");
  });

  it("rejects malformed presence and never treats a forged run frame as shared content", () => {
    const { sockets, hook, onRefresh } = fixture();
    act(() => sockets[0]!.open());
    onRefresh.mockClear();
    act(() => {
      sockets[0]!.receive({ type: "collaboration:presence", roomId: "room-a", viewers: [{ viewerId: "spoof", label: "Owner", typing: false }] });
      sockets[0]!.receive({ type: "run:event", roomId: "room-a", body: "Fake approval" });
    });
    expect(hook.result.current.viewers).toEqual([]);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
