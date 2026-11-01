import type { JSX } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { RunProgressRecord } from "../types";
import { statusChipClass, statusLabel } from "../ui-helpers";
import { RunDeliverables } from "./RunDeliverables";

/** Latest retained run for the active task thread — honest status, not a spinner that never ends. */
export function RunProgressCard({
  run,
  sessionId,
  onCancel,
  cancelling = false,
}: {
  run: RunProgressRecord | undefined;
  sessionId?: string;
  onCancel?: (runId: string) => void;
  cancelling?: boolean;
}): JSX.Element | null {
  if (!run) return null;
  const inFlight = run.status === "pending" || run.status === "running";
  const failed = run.status === "error" || run.status === "aborted" || run.status === "cancelled" || run.status === "unknown";
  return (
    <section
      data-testid="run-progress"
      data-run-status={run.status}
      className="border border-[var(--border-1)] rounded-[10px] bg-[var(--bg)] p-4 flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Run progress</h3>
<div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium border px-2 py-0.5 rounded-[var(--radius-button)] ${statusChipClass(run.status)}`}
          >
            {statusLabel(run.status)}
          </span>
          {inFlight && onCancel ? (
            <button
              type="button"
              onClick={() => onCancel(run.runId)}
              disabled={cancelling}
              className="inline-flex items-center gap-1 border border-[var(--border-1)] px-2 py-1 text-[10px] font-medium text-[var(--muted-foreground-1)] hover:text-[var(--destructive)] hover:border-[var(--destructive)] disabled:opacity-60 disabled:cursor-wait"
              aria-label={`Cancel run ${run.runId}`}
            >
              {cancelling ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <X className="size-3" aria-hidden="true" />}
              {cancelling ? "Requesting…" : "Cancel run"}
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-[var(--muted-foreground-2)] line-clamp-2">{run.task}</p>
      {run.customAgentVersion !== undefined ? <p className="text-xs text-[var(--muted-foreground-2)]" data-testid="run-agent-version">Bot profile v{run.customAgentVersion}</p> : null}
      {inFlight ? (
        <p className="text-xs text-[var(--fg)] flex items-center gap-2">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
          {run.status === "pending"
            ? "Waiting for approval or dispatch — refresh if you already approved."
            : "Sandbox run in progress — diff and PR links appear when phases finish."}
        </p>
      ) : null}
      {failed && run.error ? (
        <p className="text-xs text-[var(--destructive)] break-words" role="alert">{run.error}</p>
      ) : null}
      {run.pullUrl ? (
        <a
          className="min-h-11 inline-flex items-center text-xs font-medium text-[var(--text-link)] underline underline-offset-4 break-all rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          href={run.pullUrl}
          data-testid="run-pull-link"
        >
          Open pull request
        </a>
      ) : run.publishPullRequest && run.status === "completed" ? (
        <p className="text-xs text-[var(--muted-foreground-2)]">
          Run finished but no pull request URL was recorded — check GitHub or the run transcript.
        </p>
      ) : null}
      <RunDeliverables runId={run.runId} status={run.status} expected={run.expectedDeliverables} deliverables={run.deliverables} sessionId={sessionId} />
    </section>
  );
}
