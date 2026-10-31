import { describe, expect, it } from "vitest";
import {
  canStartRunWithBudget,
  executionBudgetSnapshot,
  resolveMaxConcurrentRuns,
  spentTodayUsd,
} from "@shiba/shared";
import type { DelegatedRun } from "@shiba/shared";

const baseRun = (overrides: Partial<DelegatedRun> = {}): DelegatedRun => ({
  runId: "r1",
  sandboxId: "s1",
  repoUrl: "https://github.com/o/r",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  generation: 0,
  status: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe("container budget guardrails", () => {
  it("defaults to five concurrent runs", () => {
    expect(resolveMaxConcurrentRuns()).toBe(5);
    expect(resolveMaxConcurrentRuns({ elevatedConcurrency: true })).toBe(10);
  });

  it("refuses new runs when the daily budget is exhausted", () => {
    const runs = [baseRun({ usage: { costUsd: 50 }, updatedAt: Date.now() })];
    const spent = spentTodayUsd(runs);
    expect(
      canStartRunWithBudget(runs, {
        elevatedConcurrency: true,
        dailyBudgetUsd: spent,
        spentTodayUsd: spent,
      }),
    ).toBe(false);
  });

  it("reports only observed usage and blocks dispatch at the exact limit", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const runs = [
      baseRun({ runId: "reported", usage: { costUsd: 2.5 }, updatedAt: now }),
      baseRun({ runId: "unknown", status: "unknown", updatedAt: now }),
    ];
    const snapshot = executionBudgetSnapshot(runs, { dailyBudgetUsd: 2.5 }, now);
    expect(snapshot).toEqual({
      accounting: "harness_reported",
      spentUsd: 2.5,
      reportedRuns: 1,
      unreportedRuns: 1,
      dailyLimitUsd: 2.5,
      limitReached: true,
      activeRuns: 1,
      maxConcurrentRuns: 5,
      dispatchAvailable: false,
    });
    expect(canStartRunWithBudget(runs, { dailyBudgetUsd: 2.5 }, now)).toBe(false);
  });

  it("keeps the configured limit open strictly below the boundary", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const runs = [baseRun({ usage: { costUsd: 2.49 }, updatedAt: now })];
    expect(executionBudgetSnapshot(runs, { dailyBudgetUsd: 2.5 }, now).limitReached).toBe(false);
    expect(canStartRunWithBudget(runs, { dailyBudgetUsd: 2.5 }, now)).toBe(true);
  });
});
