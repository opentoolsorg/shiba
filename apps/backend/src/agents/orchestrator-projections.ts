import { runTimedOut } from "../public-error.js";
import { type RunErrorCode, type RunErrorWire, runErrorWire } from "../run-errors.js";
import { type DelegatedRun, type RunStatus } from "../runs.js";

export function terminalStatusFor(code: RunErrorCode): RunStatus {
  return code === "cancelled"
    ? "cancelled"
    : code === "outcome_unknown" || code === "container_lost"
      ? "unknown"
      : "error";
}

export function dependentRuns(runs: readonly DelegatedRun[], runId: string): DelegatedRun[] {
  const visited = new Set([runId]);
  const pending = [runId];
  const dependents: DelegatedRun[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const parentId = pending[index]!;
    for (const run of runs) {
      if (visited.has(run.runId) || (run.reviewOf !== parentId && run.parentRunId !== parentId)) continue;
      visited.add(run.runId);
      pending.push(run.runId);
      // A finished intermediary can still have an active subagent or review.
      dependents.push(run);
    }
  }
  return dependents;
}

export function serializeRun(run: DelegatedRun): DelegatedRun & { errorWire?: RunErrorWire; timedOut?: boolean } {
  const timedOut = runTimedOut(run);
  // The sealed env never leaves the DO through the API.
  const visible = { ...run };
  delete visible.envSealed;
  const projected = visible.errorCode ? { ...visible, errorWire: runErrorWire(visible.errorCode) } : visible;
  return timedOut ? { ...projected, timedOut: true } : projected;
}
