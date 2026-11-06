// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRunFrame } from "../conversation-room-realtime";
import { RunLivePanel } from "./RunLivePanel";

const realtime = vi.hoisted(() => ({ onRunEvent: undefined as ((frame: ConversationRunFrame) => void) | undefined }));
vi.mock("../conversation-room-realtime", () => ({
  useConversationRoomRealtime: (options: { onRunEvent: (frame: ConversationRunFrame) => void }) => {
    realtime.onRunEvent = options.onRunEvent;
    return { status: "connected", viewers: [], viewerId: "viewer", replayGap: false, setCursor: vi.fn() };
  },
}));
vi.mock("./ConversationRoomPresence", () => ({ ConversationRoomPresence: () => null }));
vi.mock("./TerminalView", () => ({ TerminalView: () => null }));
vi.mock("./DiffViewer", () => ({ DiffViewer: ({ diff }: { diff: string }) => <section aria-label="Diff snapshot"><pre>{diff}</pre></section> }));

afterEach(() => { cleanup(); realtime.onRunEvent = undefined; });

function frame(event: ConversationRunFrame["event"]) {
  act(() => realtime.onRunEvent?.({ sequence: 1, runId: "run-1", event }));
}

describe("RunLivePanel diff snapshots", () => {
  it("replaces the displayed snapshot only when all chunks arrive and clears an empty snapshot", () => {
    render(<RunLivePanel runId="run-1" />);
    frame({ kind: "diff", data: "first snapshot", reset: true, complete: true });
    frame({ kind: "diff", data: "next ", reset: true, complete: false });
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("first snapshot");
    frame({ kind: "diff", data: "snapshot", reset: false, complete: true });
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("next snapshot");
    frame({ kind: "diff", data: "orphaned suffix", reset: false, complete: true });
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("next snapshot");
    frame({ kind: "diff", data: "", reset: true, complete: true });
    expect(screen.queryByLabelText("Diff snapshot")).toBeNull();
  });

  it.each(["diff_limited", "diff_unavailable"])("labels a stale snapshot after %s and recovers only with a complete replacement", (status) => {
    render(<RunLivePanel runId="run-1" />);
    frame({ kind: "status", status: "code", message: "Coding is active." });
    frame({ kind: "diff", data: "retained snapshot", reset: true, complete: true });
    frame({ kind: "diff", data: "incomplete", reset: true, complete: false });
    frame({ kind: "status", status, message: "Current diff preview is unavailable." });
    expect(screen.getByText("Current diff preview is unavailable.")).toBeTruthy();
    expect(screen.getByText("Coding is active.")).toBeTruthy();
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("retained snapshot");
    frame({ kind: "diff", data: "late incomplete tail", reset: false, complete: true });
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("retained snapshot");
    frame({ kind: "diff", data: "fresh snapshot", reset: true, complete: true });
    expect(screen.queryByText("Current diff preview is unavailable.")).toBeNull();
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("fresh snapshot");
  });

  it("rejects an oversized snapshot without displaying a silently truncated patch", () => {
    render(<RunLivePanel runId="run-1" />);
    frame({ kind: "diff", data: "retained snapshot", reset: true, complete: true });
    frame({ kind: "diff", data: "x".repeat(500_001), reset: true, complete: false });
    frame({ kind: "diff", data: "tail", reset: false, complete: true });
    expect(screen.getByText("The diff preview reached its display limit. Showing the last complete snapshot.")).toBeTruthy();
    expect(screen.getByLabelText("Diff snapshot").textContent).toBe("retained snapshot");
  });
});
