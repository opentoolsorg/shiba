import type { CaptainCrewEntry, CaptainDigest } from "@shiba/shared";
import type { PendingApproval } from "../pending-approvals.js";
import type { DelegatedRun } from "../runs.js";
import { isActiveStatus } from "../runs.js";

export function buildCaptainDigest(
  runs: DelegatedRun[],
  approvals: PendingApproval[],
  now = Date.now(),
): CaptainDigest {
  const pendingApprovals = approvals.filter((item) => item.status === "pending").length;
  let activeRuns = 0;
  let completedRuns = 0;
  const needsYou: string[] = [];
  for (const run of runs) {
    if (isActiveStatus(run.status)) activeRuns += 1;
    if (run.status === "completed") completedRuns += 1;
    if (run.status === "error" || run.status === "unknown") {
      needsYou.push(`Run ${run.runId} failed — inspect the thread.`);
    }
  }
  if (pendingApprovals > 0) {
    needsYou.unshift(`${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting.`);
  }
  return {
    updatedAt: now,
    pendingApprovals,
    activeRuns,
    completedRuns,
    needsYou: needsYou.slice(0, 12),
  };
}

export function buildCrewFromRuns(runs: DelegatedRun[]): CaptainCrewEntry[] {
  return runs
    .filter((run) => run.subagentPath !== undefined || run.parentRunId === undefined)
    .map((run) => ({
      runId: run.runId,
      path: run.subagentPath,
      task: run.task,
      repoUrl: run.repoUrl,
      status: run.status,
      updatedAt: run.updatedAt,
      ...(run.pullUrl ? { pullUrl: run.pullUrl } : {}),
    }))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}
