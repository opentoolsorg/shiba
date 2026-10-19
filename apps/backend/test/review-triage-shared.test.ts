import { describe, expect, it } from "vitest";
import { patchFindingTriage, type ReviewRound } from "@shiba/shared";

const round: ReviewRound = {
  roundId: "r:1",
  codingRunId: "run-1",
  reviewRunId: "rev-1",
  pull: { owner: "o", repo: "r", number: 1, headSha: "abc", url: "https://github.com/o/r/pull/1" },
  status: "posted",
  findings: [
    {
      id: "f1",
      path: "src/a.ts",
      line: 1,
      category: "bug",
      severity: "high",
      confidence: "confirmed",
      title: "t",
      failureScenario: "x",
      triage: "open",
    },
  ],
  summary: "",
};

describe("patchFindingTriage", () => {
  it("updates one finding", () => {
    const next = patchFindingTriage(round, "f1", "resolved");
    expect(next?.findings[0]?.triage).toBe("resolved");
  });

  it("returns null for unknown ids", () => {
    expect(patchFindingTriage(round, "missing", "irrelevant")).toBeNull();
  });
});
