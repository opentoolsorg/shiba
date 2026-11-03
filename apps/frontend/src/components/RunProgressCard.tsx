import type { JSX } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { RunProgressRecord } from "../types";
import { statusChipClass, statusLabel } from "../ui-helpers";
import { RunDeliverables } from "./RunDeliverables";
import { RunLivePanel } from "./RunLivePanel";

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
  const bundle = run.artifactBundle;
  let bundleUrl: string | undefined;
  if (bundle && bundle.expiresAt > Date.now()) {
    try {
      const url = new URL(bundle.downloadUrl);
      if (url.protocol === "https:" && !url.username && !url.password) bundleUrl = url.toString();
    } catch { /* Invalid download capabilities are never rendered as links. */ }
  }
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
            ? "Waiting for approval or dispatch. Refresh if you already approved."
            : "Sandbox run in progress. Live output and diffs appear as work progresses."}
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
          The changes are ready. Review the separate publication approval before publishing the pull request.
        </p>
      ) : null}
      {run.status === "completed" && bundle ? (
        <div className="text-xs text-[var(--fg)]">
          {bundleUrl ? <a href={bundleUrl} referrerPolicy="no-referrer" className="min-h-11 inline-flex items-center font-medium text-[var(--text-link)] underline underline-offset-4">Download artifacts ZIP</a>
            : <p>The artifact download link has expired or is unavailable.</p>}
          <p>{bundle.fileCount} files. Links expire after seven days.</p>
        </div>
      ) : null}
      <RunDeliverables runId={run.runId} status={run.status} expected={run.expectedDeliverables} deliverables={run.deliverables} sessionId={sessionId} />
      <RunLivePanel key={`${sessionId ?? "default"}:${run.runId}`} runId={run.runId} sessionId={sessionId} />
    </section>
  );
}
