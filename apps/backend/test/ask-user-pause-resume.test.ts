import { describe, expect, it } from "vitest";
import { askUserResumeDisposition, runPausedForAskUser } from "../src/run-resume.js";
import type { DelegatedRun } from "@shiba/shared";

const baseRun = (over: Partial<DelegatedRun> = {}): DelegatedRun =>
  ({
    runId: "run_1",
    task: "Pick a file",
    repoUrl: "https://github.com/o/r",
    status: "running",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as DelegatedRun;

describe("ask_user pause and resume", () => {
  it("detects ask_user.pending signal", () => {
    const pause = runPausedForAskUser(baseRun({
      signals: [{ kind: "ask_user.pending", at: 10, detail: "ask_1" }],
    }));
    expect(pause?.askId).toBe("ask_1");
  });

  it("resumes only for the matching answered ask id", () => {
    const run = baseRun({
      signals: [
        { kind: "ask_user.pending", at: 10, detail: "ask_1" },
        { kind: "ask_user.answered", at: 20, detail: "ask_1" },
      ],
    });
    expect(askUserResumeDisposition(run, "ask_1")).toBe("resume");
    expect(askUserResumeDisposition(run, "ask_2")).toBe("unknown");
  });
});