/**
 * Review retry: re-post only when the reviewer already finished and GitHub
 * rejected the post. Every other failure re-runs the reviewer agent.
 */
import type { ReviewLoopSettings, ReviewRound } from "@shiba/shared";

export type ReviewRetryPlan = "rerun" | "repost" | "noop";

export function reviewRetryPlan(
  round: ReviewRound,
  reviewRun: { status: string } | null,
): ReviewRetryPlan {
  if (round.status === "posted") return "noop";
  const produced = round.findings.length > 0 || round.summary.trim() !== "";
  if (round.status === "failed" && produced && reviewRun?.status === "completed") return "repost";
  return "rerun";
}

/** autoMerge queues a human merge approval only after a clean posted review. */
export function shouldQueueAutoMerge(
  loop: Pick<ReviewLoopSettings, "enabled" | "autoMerge"> | undefined,
  round: ReviewRound | null | undefined,
): boolean {
  if (!loop?.enabled || !loop.autoMerge || !round || round.status !== "posted") return false;
  return !round.findings.some((finding) => finding.severity === "high" && finding.triage !== "irrelevant");
}
