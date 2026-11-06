import { describe, expect, it } from "vitest";
import type { ReviewRound } from "@shiba/shared";
import { reviewRetryPlan } from "../src/review/retry-plan.js";

const round: ReviewRound = {
  roundId: "coding:head",
  codingRunId: "coding",
  reviewRunId: "review",
  pull: { owner: "owner", repo: "repo", number: 1, headSha: "head", url: "https://github.com/owner/repo/pull/1" },
  status: "failed",
  findings: [],
  summary: "Completed review.",
};

describe("review publication retry safety", () => {
  it.each(["posting", "unknown"] as const)("refuses automatic repost and rerun for a %s outcome", (publicationOutcome) => {
    expect(reviewRetryPlan({ ...round, publicationOutcome }, { status: "completed" })).toBe("unknown");
    expect(reviewRetryPlan({ ...round, publicationOutcome }, { status: "error" })).toBe("unknown");
    expect(reviewRetryPlan({ ...round, publicationOutcome, summary: "" }, null)).toBe("unknown");
  });

  it("retains the existing retry path after a proven rejection", () => {
    expect(reviewRetryPlan(round, { status: "completed" })).toBe("repost");
    expect(reviewRetryPlan({ ...round, summary: "" }, { status: "error" })).toBe("rerun");
    expect(reviewRetryPlan({ ...round, status: "posted" }, { status: "completed" })).toBe("noop");
  });
});
