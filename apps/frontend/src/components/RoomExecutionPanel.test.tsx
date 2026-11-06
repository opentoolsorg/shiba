// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRunFrame } from "../conversation-room-realtime";
import { RoomExecutionPanel } from "./RoomExecutionPanel";

vi.mock("./TerminalView", () => ({ TerminalView: ({ text }: { text: string }) => <pre role="log" aria-label="Terminal">{text}</pre> }));
vi.mock("./DiffViewer", () => ({ DiffViewer: ({ diff }: { diff: string }) => <pre role="log" aria-label="Diff">{diff}</pre> }));

const ROOM = `room_${"a".repeat(24)}`;
const OTHER_ROOM = `room_${"b".repeat(24)}`;
const HANDOFF = "handoff-one";
const RUN = "agent-tool:approval-one";
const props = { roomId: ROOM, handoffId: HANDOFF, runId: RUN };
const fetchMock = vi.fn<typeof fetch>();

function frame(sequence: number, event: ConversationRunFrame["event"], runId = RUN): ConversationRunFrame {
  return { sequence, runId, event };
}
function body(frames: ConversationRunFrame[] = [], options: Record<string, unknown> = {}) {
  const latest = frames.at(-1)?.sequence ?? 0;
  return { roomId: ROOM, handoffId: HANDOFF, runId: RUN, runtime: "sandbox", status: "running", source: "trusted-run-journal",
    readOnly: true, after: 0, oldest: frames[0]?.sequence ?? 0, latest, nextCursor: latest, hasMore: false, gap: false, frames, ...options };
}
const response = (frames: ConversationRunFrame[] = [], options: Record<string, unknown> = {}) => Response.json(body(frames, options));
async function flush() { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); }); }
async function tick(ms = 1_500) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("RoomExecutionPanel membership-bound replay", () => {
  it("uses authenticated read-only HTTP in the selected workspace and shows the actual runtime and task journal", async () => {
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "terminal", stream: "stdout", data: "hello\n" }),
      frame(2, { kind: "terminal", stream: "stderr", data: "warning\n" }),
      frame(3, { kind: "child", childId: "reviewer", status: "completed" }),
    ], { runtime: "local", status: "completed" }));
    render(<RoomExecutionPanel {...props} workspaceId={`ws_${"c".repeat(24)}`} />);
    await flush();
    expect(screen.getByLabelText("Terminal").textContent).toBe("hello\nwarning\n");
    expect(screen.getByText("Paired local runtime")).toBeTruthy();
    expect(screen.getByLabelText("Task specialist status").textContent).toContain("reviewer: completed");
    const [path, options] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/collaboration/rooms/${ROOM}/handoffs/${HANDOFF}/live?after=0`);
    expect(options).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(new Headers(options?.headers).get("X-Shiba-Workspace")).toBe(`ws_${"c".repeat(24)}`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("drains pages in order and only displays complete diff snapshots, including an empty replacement", async () => {
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "diff", data: "first", reset: true, complete: true }),
      frame(2, { kind: "diff", data: "next ", reset: true, complete: false }),
    ], { hasMore: true, latest: 3 }));
    fetchMock.mockResolvedValueOnce(response([
      frame(3, { kind: "diff", data: "snapshot", reset: false, complete: true }),
    ], { after: 2, oldest: 1 }));
    render(<RoomExecutionPanel {...props} />);
    await flush();
    expect(screen.getByLabelText("Diff").textContent).toBe("first");
    await tick(0);
    expect(screen.getByLabelText("Diff").textContent).toBe("next snapshot");
    expect(fetchMock.mock.calls[1]![0]).toContain("after=2");
    fetchMock.mockResolvedValueOnce(response([frame(4, { kind: "diff", data: "orphan", reset: false, complete: true })], { after: 3, oldest: 1 }));
    await tick();
    expect(screen.getByLabelText("Diff").textContent).toBe("next snapshot");
    fetchMock.mockResolvedValueOnce(response([frame(5, { kind: "diff", data: "", reset: true, complete: true })], { after: 4, oldest: 1 }));
    await tick();
    expect(screen.queryByLabelText("Diff")).toBeNull();
  });

  it("rejects an incomplete snapshot across a retention gap and labels retained output", async () => {
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "diff", data: "safe", reset: true, complete: true }),
      frame(2, { kind: "diff", data: "incomplete ", reset: true, complete: false }),
    ]));
    fetchMock.mockResolvedValueOnce(response([
      frame(5, { kind: "diff", data: "missing-middle suffix", reset: false, complete: true }),
      frame(6, { kind: "terminal", stream: "stdout", data: "retained\n" }),
    ], { after: 2, gap: true }));
    render(<RoomExecutionPanel {...props} />);
    await flush(); await tick();
    expect(screen.getByLabelText("Diff").textContent).toBe("safe");
    expect(screen.getByText(/Some output is unavailable/)).toBeTruthy();
    expect(screen.getByLabelText("Terminal").textContent).toBe("retained\n");
  });

  it("keeps checking completed runs and clears every output on membership revocation", async () => {
    const lost = vi.fn();
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "terminal", stream: "stdout", data: "sensitive result" }),
      frame(2, { kind: "diff", data: "private diff", reset: true, complete: true }),
      frame(3, { kind: "child", childId: "private-reviewer", status: "completed" }),
    ], { status: "completed" }));
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Not found" }, { status: 404 }));
    render(<RoomExecutionPanel {...props} onAccessLost={lost} />);
    await flush();
    expect(screen.getByText("sensitive result")).toBeTruthy();
    await tick();
    expect(screen.queryByText("sensitive result")).toBeNull();
    expect(screen.queryByLabelText("Diff")).toBeNull();
    expect(screen.queryByLabelText("Task specialist status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("access is unavailable");
    expect(lost).toHaveBeenCalledOnce();
    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores late HTTP and JSON responses after room, handoff or workspace navigation", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<RoomExecutionPanel {...props} workspaceId="default" />);
    fetchMock.mockResolvedValueOnce(response([frame(1, { kind: "terminal", stream: "stdout", data: "new room" })], { roomId: OTHER_ROOM }));
    rerender(<RoomExecutionPanel {...props} roomId={OTHER_ROOM} workspaceId={`ws_${"d".repeat(24)}`} />);
    await flush();
    await act(async () => { resolveOld(response([frame(1, { kind: "terminal", stream: "stdout", data: "old private room" })])); });
    expect(screen.queryByText("old private room")).toBeNull();
    expect(screen.getByLabelText("Terminal").textContent).toBe("new room");
    expect((fetchMock.mock.calls[0]![1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("does not display cached output even for one render during source changes", async () => {
    fetchMock.mockResolvedValueOnce(response([frame(1, { kind: "terminal", stream: "stdout", data: "old source" })]));
    const { rerender } = render(<RoomExecutionPanel {...props} />);
    await flush();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<RoomExecutionPanel {...props} handoffId="handoff-two" />);
    expect(screen.queryByText("old source")).toBeNull();
  });

  it("clears output if current access cannot be verified, then replays from zero after recovery", async () => {
    fetchMock.mockResolvedValueOnce(response([frame(1, { kind: "terminal", stream: "stdout", data: "cached" })]));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(response([frame(1, { kind: "terminal", stream: "stdout", data: "recovered" })]));
    render(<RoomExecutionPanel {...props} />);
    await flush(); await tick();
    expect(screen.queryByText("cached")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Unable to verify");
    await tick();
    expect(fetchMock.mock.calls[2]![0]).toContain("after=0");
    expect(screen.getByText("recovered")).toBeTruthy();
  });

  it("rejects another run's response and injected frames without displaying a partial result", async () => {
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "terminal", stream: "stdout", data: "partial" }),
      frame(2, { kind: "terminal", stream: "stdout", data: "other private run" }, "other"),
    ]));
    render(<RoomExecutionPanel {...props} />);
    await flush();
    expect(screen.getByLabelText("Terminal").textContent).toBe("");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("labels terminal display bounds and refuses oversized diff snapshots", async () => {
    fetchMock.mockResolvedValueOnce(response([
      frame(1, { kind: "diff", data: "complete safe snapshot", reset: true, complete: true }),
      ...Array.from({ length: 126 }, (_, index) => frame(index + 2, { kind: "diff", data: "x".repeat(4_000), reset: index === 0, complete: index === 125 })),
      ...Array.from({ length: 64 }, (_, index) => frame(index + 128, { kind: "terminal", stream: "stdout", data: "x".repeat(4_000) })),
    ]));
    render(<RoomExecutionPanel {...props} />);
    await flush();
    expect(screen.getByLabelText("Terminal").textContent).toHaveLength(250_000);
    expect(screen.getByLabelText("Diff").textContent).toBe("complete safe snapshot");
    expect(screen.getByText(/diff preview reached its display limit/)).toBeTruthy();
    expect(screen.getByText(/Some output is unavailable/)).toBeTruthy();
  });
});
