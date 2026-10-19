import { describe, expect, it } from "vitest";
import {
  canStartRunWithBudget,
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
});
