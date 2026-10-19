import { describe, expect, it } from "vitest";
import type { DelegatedRun, ReviewRound } from "@shiba/shared";
import { decideChain } from "../src/review/chain.js";

function run(patch: Partial<DelegatedRun>): DelegatedRun {
  return {
    runId: "run-1",
    sandboxId: "sb",
    repoUrl: "https://github.com/acme/widgets",
    task: "ship it",
    baseBranch: "main",
    publishPullRequest: true,
    reviewAfterPublish: true,
    generation: 2,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    pullUrl: "https://github.com/acme/widgets/pull/4",
    ...patch,
  };
}

const roundA: ReviewRound = {
  roundId: "run-1:abc",
  codingRunId: "run-1",
  reviewRunId: "rev-1",
  pull: { owner: "acme", repo: "widgets", number: 4, headSha: "abc", url: "https://github.com/acme/widgets/pull/4" },
  status: "posted",
  findings: [],
  summary: "",
};

describe("decideChain", () => {
  it("does not queue when the review loop is disabled", () => {
    expect(decideChain(run({}), [], "def", { enabled: false })).toEqual({ kind: "none", reason: "review loop disabled" });
  });

  it("queues from an enabled review loop even without the publish flag", () => {
    expect(decideChain(run({ reviewAfterPublish: false }), [], "def", { enabled: true }).kind).toBe("queue_review");
  });

  it("queues when the approved publish has no round for the head", () => {
    expect(decideChain(run({}), [], "def")).toEqual({ kind: "queue_review", reason: "approved review for head" });
  });

  it("queues again when the head sha moves (incremental re-review)", () => {
    expect(decideChain(run({}), [roundA], "def").kind).toBe("queue_review");
  });

  it("does not queue a duplicate round for the same head", () => {
    expect(decideChain(run({}), [roundA], "abc").kind).toBe("none");
  });

  it("queues again when the only round for the head failed", () => {
    const failed: ReviewRound = { ...roundA, status: "failed", error: "review_run_error" };
    expect(decideChain(run({}), [failed], "abc").kind).toBe("queue_review");
  });

  it("does not queue a reviewer, unapproved publish, or incomplete run", () => {
    expect(decideChain(run({ reviewOf: "run-0" }), [], "abc").kind).toBe("none");
    expect(decideChain(run({ reviewAfterPublish: false }), [], "abc").kind).toBe("none");
    expect(decideChain(run({ pullUrl: undefined }), [], "abc").kind).toBe("none");
    expect(decideChain(run({ status: "running" }), [], "abc").kind).toBe("none");
  });
});
