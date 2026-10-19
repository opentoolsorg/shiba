import type { JSX } from "react";
import { LoaderCircle } from "lucide-react";
import type { RetainedRun } from "../types";
import { statusChipClass, statusLabel } from "../ui-helpers";

/** Latest retained run for the active task thread — honest status, not a spinner that never ends. */
export function RunProgressCard({ run }: { run: RetainedRun | undefined }): JSX.Element | null {
  if (!run) return null;
  const inFlight = run.status === "pending" || run.status === "running";
  const failed = run.status === "error" || run.status === "aborted" || run.status === "cancelled" || run.status === "unknown";
  return (
    <section
      data-testid="run-progress"
      data-run-status={run.status}
      className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Run progress</h3>
        <span
          className={`text-[10px] uppercase tracking-wider font-bold border px-2 py-0.5 rounded-[var(--radius-button)] ${statusChipClass(run.status)}`}
        >
          {statusLabel(run.status)}
        </span>
      </div>
      <p className="text-xs text-[var(--muted-foreground-2)] line-clamp-2">{run.task}</p>
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
          className="text-xs font-medium text-[var(--primary)] underline break-all"
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
    </section>
  );
}
