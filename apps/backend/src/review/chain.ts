import type { DelegatedRun, ReviewRound } from "@shiba/shared";

export interface ChainDecision {
  kind: "queue_review" | "none";
  reason: string;
}

/** Queue a reviewer only after an approved publish, and only once per coding run. */
export function decideChain(run: DelegatedRun, existing: ReviewRound | undefined): ChainDecision {
  if (run.reviewOf) return { kind: "none", reason: "reviewer run" };
  if (run.status !== "completed") return { kind: "none", reason: "not completed" };
  if (!run.pullUrl) return { kind: "none", reason: "no pull request" };
  if (run.reviewAfterPublish !== true) return { kind: "none", reason: "review not approved" };
  if (existing) return { kind: "none", reason: "round exists" };
  return { kind: "queue_review", reason: "approved review after publish" };
}
