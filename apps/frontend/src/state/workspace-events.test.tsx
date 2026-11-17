// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceEvents } from "./workspace-events";

class Socket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor(readonly url: URL) {}
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  vi.stubGlobal("WebSocket", class extends Socket {
    constructor(url: URL) { super(url); sockets.push(this); }
  });
  return sockets;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("workspace shared transport", () => {
  it("shares one socket, fans out frames, and closes after the last consumer", () => {
    const sockets = fixture();
    const first = vi.fn(), second = vi.fn();
    const a = renderHook(() => useWorkspaceEvents({ workspaceId: "ws_a", enabled: true, onEvent: first }));
    const b = renderHook(() => useWorkspaceEvents({ workspaceId: "ws_a", enabled: true, onEvent: second }));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url.pathname).toBe("/api/workspaces/ws_a/events");
    act(() => sockets[0]!.open());
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
    const event = { workspaceId: "ws_a", kind: "note.updated", entityId: "note_1", payload: { title: "New title" } };
    act(() => sockets[0]!.receive(event));
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    a.unmount();
    expect(sockets[0]!.readyState).toBe(1);
    b.unmount();
    expect(sockets[0]!.readyState).toBe(3);
    act(() => vi.advanceTimersByTime(60_000));
    expect(sockets).toHaveLength(1);
  });

  it("backs off failed connections and catches up once per successful reconnect", () => {
    const sockets = fixture();
    const catchUp = vi.fn();
    const hook = renderHook(() => useWorkspaceEvents({ workspaceId: "ws_a", enabled: true, onEvent: vi.fn(), onReconnect: catchUp }));
    act(() => sockets[0]!.open());
    expect(catchUp).not.toHaveBeenCalled();
    act(() => sockets[0]!.close());
    expect(hook.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(499));
    expect(sockets).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1]!.close());
    act(() => vi.advanceTimersByTime(999));
    expect(sockets).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    act(() => sockets[2]!.open());
    expect(hook.result.current).toBe(true);
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it("isolates workspace changes and rejects foreign or malformed frames", () => {
    const sockets = fixture();
    const receive = vi.fn();
    const hook = renderHook(({ workspaceId }) => useWorkspaceEvents({ workspaceId, enabled: true, onEvent: receive }), { initialProps: { workspaceId: "ws_a" } });
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.receive({ workspaceId: "ws_b", kind: "room.created", entityId: "r" }));
    act(() => sockets[0]!.receive(null));
    expect(receive).not.toHaveBeenCalled();
    hook.rerender({ workspaceId: "ws_b" });
    expect(hook.result.current).toBe(false);
    expect(sockets[0]!.readyState).toBe(3);
    act(() => sockets[0]!.receive({ workspaceId: "ws_a", kind: "room.created", entityId: "r" }));
    expect(receive).not.toHaveBeenCalled();
    act(() => sockets[1]!.open());
    expect(hook.result.current).toBe(true);
  });

  it("detects silent socket loss with a heartbeat and cancels retries on disable", () => {
    const sockets = fixture();
    const hook = renderHook(({ enabled }) => useWorkspaceEvents({ workspaceId: "ws_a", enabled, onEvent: vi.fn() }), { initialProps: { enabled: true } });
    act(() => sockets[0]!.open());
    act(() => vi.advanceTimersByTime(75_000));
    expect(sockets[0]!.send).toHaveBeenCalledWith("ping");
    expect(hook.result.current).toBe(false);
    hook.rerender({ enabled: false });
    act(() => vi.advanceTimersByTime(60_000));
    expect(sockets).toHaveLength(1);
  });
});
