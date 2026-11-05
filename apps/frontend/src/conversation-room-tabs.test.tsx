// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationRoomRealtime } from "./conversation-room-realtime";

const browser = vi.hoisted(() => ({ environment: undefined as Parameters<typeof import("./room-tab-identity").roomTabIdentity>[0] }));
vi.mock("./room-tab-identity", async (original) => {
  const actual = await original<typeof import("./room-tab-identity")>();
  return { ...actual, roomTabIdentity: () => actual.roomTabIdentity(browser.environment) };
});

class SharedLocks implements Pick<LockManager, "request"> {
  readonly held = new Set<string>();
  calls = 0;
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
    this.calls++;
    const granted = typeof options === "function" ? options : callback;
    if (!granted) throw new Error("Missing callback");
    if (this.held.has(name)) return Promise.resolve().then(() => granted(null));
    this.held.add(name);
    return Promise.resolve().then(() => granted({ name, mode: "exclusive" })).finally(() => { this.held.delete(name); });
  }
}

class RoomSocket {
  static OPEN = 1;
  readyState = 0;
  readonly nonce: string;
  readonly viewerId: string;
  private listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(readonly url: string, private readonly room: RoomRelay) {
    this.nonce = new URL(url).searchParams.get("viewer")!;
    // Represents a server-supplied identity, never client authentication.
    this.viewerId = room.alias ? `${(Number.parseInt(this.nonce[0]!, 16) ^ 1).toString(16)}${this.nonce.slice(1)}` : this.nonce;
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  send(raw: string) { if (raw !== "ping") this.room.from(this, JSON.parse(raw) as Record<string, unknown>); }
  open() {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener(new Event("open"));
    this.receive({ type: "snapshot", viewerId: this.viewerId, viewers: this.room.viewers(), messages: [], streams: [] });
    this.room.broadcast({ type: "presence", viewers: this.room.viewers() });
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener(new Event("close"));
    this.room.broadcast({ type: "presence", viewers: this.room.viewers() });
  }
}
class RoomRelay {
  readonly sockets: RoomSocket[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  private streams = new Map<string, { owner: RoomSocket; text: string }>();
  constructor(readonly alias: boolean) {}
  viewers() { return this.sockets.filter((socket) => socket.readyState === 1).map((socket) => ({ viewerId: socket.viewerId, joinedAt: 1, typing: false, label: "Verified owner fixture" })); }
  broadcast(frame: unknown) { for (const socket of this.sockets) if (socket.readyState === 1) socket.receive(frame); }
  from(socket: RoomSocket, frame: Record<string, unknown>) {
    const streamId = String(frame.streamId);
    if (frame.type === "message") { this.messages.push({ ...frame, viewerId: socket.viewerId }); this.broadcast({ ...frame, viewerId: socket.viewerId, createdAt: 1 }); }
    else if (frame.type === "stream:start") { this.streams.set(streamId, { owner: socket, text: "" }); this.broadcast({ ...frame, viewerId: socket.viewerId }); }
    else if (frame.type === "stream:delta") {
      const stream = this.streams.get(streamId);
      if (stream?.owner === socket) { stream.text += String(frame.delta); this.broadcast({ type: "stream:delta", streamId, viewerId: socket.viewerId, text: stream.text }); }
    } else if (frame.type === "stream:end" && this.streams.get(streamId)?.owner === socket) {
      this.broadcast({ ...frame, viewerId: socket.viewerId }); this.streams.delete(streamId);
    } else if (frame.type === "subscribe") socket.receive({ type: "run:replay_complete", sequence: 0 });
  }
}
const seed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function tab(locks?: SharedLocks) {
  const values = new Map([["shiba-room-viewer:lease-v1", seed]]);
  return { navigator: { locks }, sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } };
}
const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
type Message = { id: string; role: string; metadata?: unknown; parts: Array<{ type: string; text: string }> };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); browser.environment = undefined; });

describe("cloned live tabs", () => {
  it.each([[true, false], [true, true], [false, true]])("receives peer chat and streams with cloned storage (locks=%s, server alias=%s)", async (withLocks, alias) => {
    vi.useFakeTimers();
    const locks = withLocks ? new SharedLocks() : undefined;
    const room = new RoomRelay(alias);
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor(url: string | URL) { super(String(url), room); room.sockets.push(this); } });
    const firstTab = tab(locks), secondTab = tab(locks);
    const onA = vi.fn(), onB = vi.fn();
    const options = (onMessage: typeof onA) => ({ sessionId: "default", enabled: true, typingText: "", messages: [] as Message[], onMessage });
    browser.environment = firstTab;
    const a = renderHook((props) => useConversationRoomRealtime(props), { initialProps: options(onA) });
    browser.environment = secondTab;
    const b = renderHook((props) => useConversationRoomRealtime(props), { initialProps: options(onB) });
    if (withLocks) expect(room.sockets).toHaveLength(0);
    await act(flush);
    expect(room.sockets).toHaveLength(2);
    expect(room.sockets[0]!.nonce).not.toBe(room.sockets[1]!.nonce);
    act(() => { room.sockets[0]!.open(); room.sockets[1]!.open(); });
    expect(a.result.current.viewers).toHaveLength(2);
    expect(b.result.current.viewers).toHaveLength(2);
    let firstStream = "", secondStream = "";
    act(() => { firstStream = a.result.current.startStream("Question A"); });
    a.rerender({ ...options(onA), messages: [
      { id: "question-a", role: "user", metadata: { shibaRoomViewerId: a.result.current.viewerId }, parts: [{ type: "text", text: "Question A" }] },
      { id: "reply-a", role: "assistant", parts: [{ type: "text", text: "Reply A" }] },
    ] });
    expect(onB).toHaveBeenCalledWith(expect.objectContaining({ messageId: "question-a", text: "Question A" }));
    expect(onA).not.toHaveBeenCalled();
    expect(b.result.current.remoteStream).toMatchObject({ viewerId: a.result.current.viewerId, text: "Reply A" });
    act(() => { secondStream = b.result.current.startStream("Question B"); });
    b.rerender({ ...options(onB), messages: [
      { id: "question-b", role: "user", metadata: { shibaRoomViewerId: b.result.current.viewerId }, parts: [{ type: "text", text: "Question B" }] },
      { id: "reply-b", role: "assistant", parts: [{ type: "text", text: "Reply B" }] },
    ] });
    expect(onA).toHaveBeenCalledWith(expect.objectContaining({ messageId: "question-b", text: "Question B" }));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(a.result.current.remoteStream).toMatchObject({ viewerId: b.result.current.viewerId, text: "Reply B" });
    act(() => { a.result.current.finishStream(firstStream, "complete"); b.result.current.finishStream(secondStream, "complete"); });
    const rawNonce = room.sockets[0]!.nonce;
    act(() => { room.sockets[0]!.close(); vi.advanceTimersByTime(1000); room.sockets[2]!.open(); });
    expect(room.sockets[2]!.nonce).toBe(rawNonce);
    a.unmount(); b.unmount();
    vi.runOnlyPendingTimers(); await flush();
    expect(locks?.held.size ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate duplicate live claims/sockets during StrictMode effect replay", async () => {
    vi.useFakeTimers();
    const locks = new SharedLocks(), room = new RoomRelay(false);
    browser.environment = tab(locks);
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor(url: string | URL) { super(String(url), room); room.sockets.push(this); } });
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const hook = renderHook(() => useConversationRoomRealtime({ sessionId: "default", enabled: true, typingText: "", messages: [], onMessage: vi.fn() }), { wrapper });
    await act(flush);
    expect(room.sockets).toHaveLength(1);
    expect(locks.calls).toBe(1);
    hook.unmount(); vi.runOnlyPendingTimers(); await flush();
    expect(locks.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a locally submitted message while its tab claim is pending", async () => {
    vi.useFakeTimers();
    const locks = new SharedLocks(), room = new RoomRelay(true);
    browser.environment = tab(locks);
    vi.stubGlobal("WebSocket", class extends RoomSocket { constructor(url: string | URL) { super(String(url), room); room.sockets.push(this); } });
    const initial = { sessionId: "default", enabled: true, typingText: "", messages: [] as Message[], onMessage: vi.fn() };
    const hook = renderHook((props) => useConversationRoomRealtime(props), { initialProps: initial });
    const provisional = hook.result.current.viewerId;
    act(() => { hook.result.current.startStream("Before claim"); });
    hook.rerender({ ...initial, messages: [{ id: "early-local", role: "user", metadata: { shibaRoomViewerId: provisional }, parts: [{ type: "text", text: "Before claim" }] }] });
    expect(room.sockets).toHaveLength(0);
    await act(flush);
    expect(room.sockets[0]!.nonce).toBe(seed);
    expect(room.sockets[0]!.nonce).not.toBe(provisional);
    act(() => room.sockets[0]!.open());
    expect(room.messages).toEqual([expect.objectContaining({ messageId: "early-local", text: "Before claim", viewerId: room.sockets[0]!.viewerId })]);
    hook.unmount(); vi.runOnlyPendingTimers(); await flush();
    expect(locks.held.size).toBe(0);
  });
});
