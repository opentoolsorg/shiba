import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildTasksHomeBuckets } from "./TasksHomeView";
import type { RetainedRun } from "../types";

describe("TasksHomeView live buckets", () => {
  it("places running work in the working queue with signal-backed progress", () => {
    const runs: RetainedRun[] = [{
      runId: "run_a",
      task: "README",
      repoUrl: "https://github.com/o/r",
      status: "running",
      generation: 1,
      createdAt: 1,
      updatedAt: 2,
      signals: [{ kind: "exec.invoked", at: 2, detail: "vitest --run" }],
    } as RetainedRun];
    const buckets = buildTasksHomeBuckets(runs, [], []);
    expect(buckets.working).toHaveLength(1);
    const withQuestion = buildTasksHomeBuckets([], [], [], [{
      runId: "run_a",
      askId: "ask_1",
      prompt: "Which file first?",
      updatedAt: 3,
      ownerLabel: "Agent",
    }]);
    expect(withQuestion.needsYou[0]?.status).toBe("Question");
    expect(withQuestion.needsYou[0]?.ownerLabel).toBe("Agent");
  });
});