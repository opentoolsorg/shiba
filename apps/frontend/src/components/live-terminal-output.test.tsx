// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRunFrame } from "../conversation-room-realtime";
import { RunLivePanel } from "./RunLivePanel";
import { RoomExecutionPanel } from "./RoomExecutionPanel";

const realtime = vi.hoisted(() => ({ onRunEvent: undefined as ((frame: ConversationRunFrame) => void) | undefined, replayGap: false }));
const xterm = vi.hoisted(() => ({ instances: [] as Array<{ write: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  write = vi.fn(); reset = vi.fn(); dispose = vi.fn(); open = vi.fn(); resize = vi.fn();
  constructor() { xterm.instances.push(this); }
} }));
vi.mock("../conversation-room-realtime", () => ({ useConversationRoomRealtime: (options: { onRunEvent: (frame: ConversationRunFrame) => void }) => {
  realtime.onRunEvent = options.onRunEvent;
  return { status: "connected", viewers: [], viewerId: "viewer", replayGap: realtime.replayGap, setCursor: vi.fn() };
} }));
vi.mock("./ConversationRoomPresence", () => ({ ConversationRoomPresence: () => null }));
vi.mock("./DiffViewer", () => ({ DiffViewer: () => null }));

beforeEach(() => { xterm.instances = []; realtime.onRunEvent = undefined; realtime.replayGap = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function flush() { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); await vi.dynamicImportSettled(); }); }
function terminalAt(index = 0) {
  const terminal = xterm.instances[index];
  if (!terminal) throw new Error("xterm did not mount");
  return terminal;
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(1_500); }); }
function send(sequence: number, data: string, runId = "run-1") { act(() => { realtime.onRunEvent?.({ sequence, runId, event: { kind: "terminal", stream: "stdout", data } }); }); }
const roomProps = { roomId: "room-one", handoffId: "handoff-one", runId: "run-1" };
function replay(frames: ConversationRunFrame[], fields: Record<string, unknown> = {}) {
  return Response.json({ ...roomProps, runtime: "sandbox", status: "running", source: "trusted-run-journal", readOnly: true,
    after: 0, oldest: frames[0]?.sequence ?? 0, latest: frames.at(-1)?.sequence ?? 0, nextCursor: frames.at(-1)?.sequence ?? 0, gap: false, hasMore: false, frames, ...fields });
}
function frame(sequence: number, data: string): ConversationRunFrame { return { sequence, runId: "run-1", event: { kind: "terminal", stream: "stdout", data } }; }

describe("capped live panels drive incremental xterm writes", () => {
  it("keeps WS writes incremental after the cap and does not reset for repeated retention warnings or empty deltas", async () => {
    render(<RunLivePanel runId="run-1" />); await flush();
    const terminal = terminalAt();
    const initial = "a".repeat(250_000);
    send(1, initial); send(2, "NEXT"); send(3, "");
    act(() => {
      realtime.onRunEvent?.({ sequence: 4, runId: "run-1", event: { kind: "status", status: "stream_gap" } });
      realtime.onRunEvent?.({ sequence: 5, runId: "run-1", event: { kind: "status", status: "stream_gap" } });
    });
    send(6, "END");
    expect(terminal.write.mock.calls).toEqual([[initial], ["NEXT"], ["END"]]);
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(screen.getByText(/Some live output is unavailable/)).toBeTruthy();
  });

  it.each([{ sessionId: "another-session" }, { runId: "run-2" }, { roomUrl: "/another-room" }])("disposes the old terminal on a run/session/room switch and ignores its captured callback: %s", async (change) => {
    const view = render(<RunLivePanel runId="run-1" />); await flush(); send(1, "private old output");
    const old = terminalAt(), staleCallback = realtime.onRunEvent;
    view.rerender(<RunLivePanel runId="run-1" {...change} />); await flush();
    const fresh = terminalAt(1);
    act(() => { staleCallback?.(frame(2, "late old output")); });
    send(1, "new output", change.runId ?? "run-1");
    expect(old.dispose).toHaveBeenCalledOnce(); expect(fresh.write.mock.calls).toEqual([["new output"]]);
    expect(screen.queryByText(/private old output|late old output/)).toBeNull();
  });

  it("resets a rewound WS source instead of appending a replacement journal", async () => {
    render(<RunLivePanel runId="run-1" />); await flush(); send(10, "old source"); send(2, "replacement source");
    const terminal = terminalAt();
    expect(terminal.reset).toHaveBeenCalledOnce(); expect(terminal.write.mock.calls).toEqual([["old source"], ["replacement source"]]);
    expect(screen.queryByText("old source")).toBeNull();
  });

  it("keeps HTTP replay writes incremental after 250k and ignores repeated retained-cursor gap markers", async () => {
    vi.useFakeTimers();
    const initial = Array.from({ length: 64 }, (_, index) => frame(index + 1, "a".repeat(4_000)));
    const fetcher = vi.fn().mockResolvedValueOnce(replay(initial))
      .mockResolvedValueOnce(replay([frame(65, "NEXT")], { after: 64, gap: true, oldest: 5 }))
      .mockResolvedValueOnce(replay([], { after: 65, oldest: 5, latest: 65, nextCursor: 65, gap: true }))
      .mockResolvedValueOnce(replay([frame(66, "END")], { after: 65, gap: true, oldest: 5 }));
    vi.stubGlobal("fetch", fetcher); render(<RoomExecutionPanel {...roomProps} />); await flush();
    const terminal = terminalAt(), writes = terminal.write.mock.calls.length, resets = terminal.reset.mock.calls.length;
    expect(screen.getByLabelText("Live terminal output").querySelector("pre")?.textContent).toHaveLength(250_000);
    await tick(); await tick(); await tick();
    expect(terminal.write.mock.calls.slice(writes)).toEqual([["NEXT"], ["END"]]);
    expect(terminal.reset).toHaveBeenCalledTimes(resets);
    expect(screen.getByText(/Some output is unavailable/)).toBeTruthy();
  });

  it("resets HTTP cursor rewinds once, then retains the new journal without repeat-gap resets", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(replay([frame(10, "old source")], { gap: true }))
      .mockResolvedValueOnce(replay([frame(1, "new source")], { after: 10, gap: true }))
      .mockResolvedValueOnce(replay([], { after: 1, oldest: 1, latest: 1, nextCursor: 1, gap: true })));
    render(<RoomExecutionPanel {...roomProps} />); await flush();
    const terminal = terminalAt(), resets = terminal.reset.mock.calls.length;
    await tick(); await tick();
    expect(terminal.reset).toHaveBeenCalledTimes(resets + 1);
    expect(terminal.write.mock.calls).toEqual([["old source"], ["new source"]]);
    expect(screen.queryByText("old source")).toBeNull();
  });

  it("clears xterm on failed current authorization and replays only freshly verified output after recovery", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(replay([frame(1, "private cached output")]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(replay([frame(1, "freshly authorized output")]));
    vi.stubGlobal("fetch", fetcher); render(<RoomExecutionPanel {...roomProps} />); await flush();
    const terminal = terminalAt(), resets = terminal.reset.mock.calls.length;
    await tick(); expect(terminal.reset).toHaveBeenCalledTimes(resets + 1);
    expect(screen.queryByText("private cached output")).toBeNull();
    await tick(); expect(terminal.write.mock.calls).toEqual([["private cached output"], ["freshly authorized output"]]);
    expect(fetcher.mock.calls[2]?.[0]).toContain("after=0");
  });

  it("resets a changed HTTP run identity even when its replay cursor advances", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(replay([frame(10, "old run")]))
      .mockResolvedValueOnce(replay([{ ...frame(11, "new run"), runId: "run-2" }], { runId: "run-2", after: 10 })));
    render(<RoomExecutionPanel roomId={roomProps.roomId} handoffId={roomProps.handoffId} />); await flush();
    const terminal = terminalAt(), resets = terminal.reset.mock.calls.length;
    await tick();
    expect(terminal.reset).toHaveBeenCalledTimes(resets + 1);
    expect(terminal.write.mock.calls).toEqual([["old run"], ["new run"]]);
    expect(screen.queryByText("old run")).toBeNull();
  });
});
