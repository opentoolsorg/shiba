import type { DelegatedRun, ReviewRound } from "@shiba/shared";
import { roundForHead } from "@shiba/shared";

export interface ChainDecision {
  kind: "queue_review" | "none";
  reason: string;
}

/** Queue a reviewer after publish, and again when the PR head moves (incremental re-review). */
export function decideChain(
  run: DelegatedRun,
  rounds: ReviewRound[],
  headSha: string,
): ChainDecision {
  if (run.reviewOf) return { kind: "none", reason: "reviewer run" };
  if (run.status !== "completed") return { kind: "none", reason: "not completed" };
  if (!run.pullUrl) return { kind: "none", reason: "no pull request" };
  if (run.reviewAfterPublish !== true) return { kind: "none", reason: "review not approved" };
  if (roundForHead(rounds, run.runId, headSha)) return { kind: "none", reason: "round exists for head" };
  return { kind: "queue_review", reason: "approved review for head" };
}
