import { describe, expect, it } from "vitest";
import { mergeSpineEvents, type SpineEventWire } from "./live-status";

const event = (seq: number, at: number, kind = "run.progress", status?: string): SpineEventWire => ({
  seq,
  at,
  commandId: `c${seq}`,
  kind,
  runId: "r1",
  ...(status ? { payload: { status } } : {}),
});

describe("execution event merge", () => {
  it("drops stale replays, deduplicates overlap, and keeps the latest same-sequence state", () => {
    const merged = mergeSpineEvents(
      [event(2, 20, "run.failed", "unknown"), event(3, 30)],
      [event(1, 10), event(2, 19, "run.failed", "error"), event(3, 30), event(4, 40)],
    );
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged[1]?.payload?.status).toBe("unknown");
  });

  it("bounds the retained timeline window", () => {
    expect(mergeSpineEvents([], [event(1, 1), event(2, 2), event(3, 3)], 2).map((e) => e.seq)).toEqual([2, 3]);
  });
});
