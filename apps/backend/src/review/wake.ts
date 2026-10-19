import type { GitHubAutomationEvent } from "../automations.js";

export type PrWakeKind = "ci_completed" | "review_submitted" | "merged" | "synchronize_re_review";

export interface PrWakeDecision {
  kind: PrWakeKind | "none";
  reason: string;
  /** When true the follow-up reuses the publish approval (reviewer only). */
  reusePublishApproval?: boolean;
}

/**
 * Map a GitHub webhook fan-out event to a thread wake. Pure — no I/O.
 * `synchronize` on an owned PR triggers incremental re-review under the original approval.
 */
export function decidePrWake(githubEvent: string, mapped: GitHubAutomationEvent): PrWakeDecision {
  if (mapped.event === "pull_request" && mapped.action === "synchronize") {
    return { kind: "synchronize_re_review", reason: "head moved", reusePublishApproval: true };
  }
  if (mapped.event === "pull_request" && mapped.action === "closed") {
    return { kind: "merged", reason: "pull request closed" };
  }
  if (githubEvent === "pull_request_review" && mapped.action === "submitted") {
    return { kind: "review_submitted", reason: "human or bot review landed" };
  }
  if (githubEvent === "check_run" && mapped.action === "completed") {
    return { kind: "ci_completed", reason: "check run finished" };
  }
  if (githubEvent === "check_suite" && mapped.action === "completed") {
    return { kind: "ci_completed", reason: "check suite finished" };
  }
  return { kind: "none", reason: "not a wake signal" };
}

export function pullNumberFromCheckPayload(payload: unknown): number | undefined {
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const checkRun =
    typeof record.check_run === "object" && record.check_run !== null
      ? (record.check_run as Record<string, unknown>)
      : typeof record.check_suite === "object" && record.check_suite !== null
        ? (record.check_suite as Record<string, unknown>)
        : null;
  const prs = checkRun?.pull_requests;
  if (!Array.isArray(prs) || prs.length === 0) return undefined;
  const first = prs[0];
  if (typeof first === "object" && first !== null && typeof (first as { number?: unknown }).number === "number") {
    return (first as { number: number }).number;
  }
  return undefined;
}

export function wakeFollowUpTask(kind: PrWakeKind, input: { repo?: string; pullNumber?: number; headSha?: string }): string {
  const pr = input.pullNumber ? `#${input.pullNumber}` : "the open PR";
  const repo = input.repo ?? "the repository";
  switch (kind) {
    case "synchronize_re_review":
      return `The PR head moved (${input.headSha ?? "new commit"}). Run a read-only incremental review on ${repo} ${pr}.`;
    case "ci_completed":
      return `CI finished on ${repo} ${pr}. Inspect check results and fix or explain any failures.`;
    case "review_submitted":
      return `A review landed on ${repo} ${pr}. Read the feedback and address requested changes if needed.`;
    case "merged":
      return `${repo} ${pr} merged. Summarize what shipped and note any follow-up work.`;
    default:
      return `Follow up on ${repo} ${pr}.`;
  }
}
