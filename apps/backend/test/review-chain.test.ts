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

const round = { roundId: "run-1:abc", status: "posted" } as ReviewRound;

describe("decideChain", () => {
  it("queues when the approved publish has no round", () => {
    expect(decideChain(run({}), undefined)).toEqual({ kind: "queue_review", reason: "approved review after publish" });
  });

  it("does not queue a second round, a reviewer, or an unapproved publish", () => {
    expect(decideChain(run({}), round).kind).toBe("none");
    expect(decideChain(run({ reviewOf: "run-0" }), undefined).kind).toBe("none");
    expect(decideChain(run({ reviewAfterPublish: false }), undefined).kind).toBe("none");
    expect(decideChain(run({ pullUrl: undefined }), undefined).kind).toBe("none");
    expect(decideChain(run({ status: "running" }), undefined).kind).toBe("none");
  });
});
