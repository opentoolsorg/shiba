import { describe, expect, it, vi } from "vitest";
import { applyRunEvents, decideRunTransition, spineInputsFromDecider, type DelegatedRun } from "@shiba/shared";
import { RunStore } from "../src/runs.js";

const run: DelegatedRun = {
  runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "Fix",
  baseBranch: "main", publishPullRequest: false, status: "pending", generation: 0, createdAt: 1, updatedAt: 1,
};

describe("archive command", () => {
  it("rejects a missing run", () => {
    expect(decideRunTransition({ run: null }, { type: "archive", runId: "r1", commandId: "a", at: 2 }))
      .toMatchObject({ error: { code: "run_not_found" } });
  });
  it.each(["pending", "running", "completed", "error", "aborted", "cancelled", "unknown"] as const)("archives %s without lifecycle changes", (status) => {
    const current = { ...run, status };
    const command = { type: "archive" as const, runId: "r1", commandId: "a", at: 2 };
    const decision = decideRunTransition({ run: current }, command);
    expect(decision).toEqual({ events: [{ type: "run.archived", commandId: "a", at: 2 }] });
    if ("error" in decision) throw new Error(decision.error.message);
    expect(spineInputsFromDecider("r1", "a", decision.events, 2)).toEqual([
      { kind: "run.archived", commandId: "a", at: 2, runId: "r1" },
    ]);
    const make = vi.fn();
    const next = applyRunEvents(current, decision.events, make)!;
    expect(next).toMatchObject({ archivedAt: 2, updatedAt: 2, generation: 1, status });
    expect(make).not.toHaveBeenCalled();
    const replay = decideRunTransition({ run: next }, { ...command, at: 3 });
    expect(replay).toMatchObject({ events: [{ replayed: true }] });
    if ("error" in replay) throw new Error(replay.error.message);
    expect(applyRunEvents(next, replay.events, make)).toEqual(next);
  });
  it("persists through the store and taps decisions, without writing a replay", () => {
    let rows = [run];
    const write = vi.fn((next: DelegatedRun[]) => { rows = next; });
    const tap = vi.fn();
    const store = new RunStore(() => rows, write, tap);
    expect(store.archiveRun("missing")).toBeNull();
    expect(store.archiveRun("r1")?.archivedAt).toBeDefined();
    store.archiveRun("r1");
    expect(write).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledTimes(2);
    expect(tap.mock.calls[0]?.[0]).toMatchObject({ type: "archive", commandId: "archive:r1:0" });
  });
});
