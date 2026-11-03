import { FileText, GitCompareArrows } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import type { VMRun } from "../types";
import {
  extractCompletedDiff,
  formatTimeAgo,
  parseRepoName,
  statusChipClass,
  statusLabel,
} from "../ui-helpers";
import { DiffViewer } from "./DiffViewer";
import { HarnessSessionPanel } from "./HarnessSessionPanel";
import { ReviewFindings } from "./ReviewFindings";
import { SubagentTree } from "./SubagentTree";

export interface DiffViewProps {
  runs: VMRun[];
  selectedRunId?: string | null;
  sessionId?: string;
  onSelectRun?: (runId: string) => void;
  /** Full run payload still loading — empty/"no diff" claims are premature. */
  loading?: boolean;
  error?: string | null;
  /** Poll the live session diff while a local harness run is in flight. */
  liveHarness?: boolean;
}

function runHasDiff(run: VMRun): boolean {
  return Boolean(extractCompletedDiff(run) ?? run.diff);
}

/** Prefer the caller's run, then the newest run that actually has a patch. */
function preferredRunId(runs: VMRun[], selected?: string | null): string {
  if (selected && runs.some((run) => run.runId === selected)) return selected;
  return runs.find(runHasDiff)?.runId ?? runs[0]?.runId ?? "";
}

export function DiffView({
  runs,
  selectedRunId,
  sessionId,
  onSelectRun,
  loading = false,
  error = null,
  liveHarness = false,
}: DiffViewProps): JSX.Element {
  const [internalSelectedId, setInternalSelectedId] = useState<string>(() =>
    preferredRunId(runs, selectedRunId),
  );

  const activeRunId =
    selectedRunId && runs.some((run) => run.runId === selectedRunId)
      ? selectedRunId
      : internalSelectedId || preferredRunId(runs, null);

  const activeRun = useMemo(
    () => runs.find((r) => r.runId === activeRunId) || runs.find(runHasDiff) || runs[0] || null,
    [runs, activeRunId],
  );

  const activeDiff = useMemo(() => {
    if (!activeRun) return null;
    return extractCompletedDiff(activeRun) ?? activeRun.diff ?? null;
  }, [activeRun]);

  const runsWithDiff = useMemo(
    () => runs.filter((r) => Boolean(extractCompletedDiff(r) ?? r.diff)),
    [runs],
  );

  const handleSelect = (runId: string) => {
    setInternalSelectedId(runId);
    onSelectRun?.(runId);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      {/* Top Header */}
      <div className="border-b border-[var(--border-1)] bg-[var(--chrome)] px-4 sm:px-6 py-2 min-h-14 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted-foreground-2)]">
          <span>Personal</span><span aria-hidden="true">&gt;</span>
          <h1 className="font-sans font-medium text-[var(--fg)]">Pull requests</h1><span aria-hidden="true">&gt;</span>
          <span>Diff review</span>
          <span className="rounded-full bg-[var(--section)] px-2 py-1 text-xs">{runsWithDiff.length} with diffs / {runs.length} total</span>
        </div>

        {/* Run Selector */}
        {runs.length > 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-[var(--muted-foreground-2)]">Run</span>
            <select
              aria-label="Select run for diff inspection"
              value={activeRun?.runId ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
              className="min-h-11 min-w-11 text-xs bg-[var(--input)] border border-[var(--border-1)] rounded-lg px-3 text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] max-w-[min(20rem,75vw)] truncate"
            >
              {runs.map((r) => {
                const hasDiff = Boolean(extractCompletedDiff(r) ?? r.diff) || r.hasDiff === true;
                return (
                  <option key={r.runId} value={r.runId}>
                    {hasDiff ? "● " : "○ "}
                    {parseRepoName(r.repoUrl)} · {r.runId.slice(0, 8)} ({statusLabel(r.status)})
                  </option>
                );
              })}
            </select>
          </div>
        ) : null}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        {liveHarness ? (
          <div className="max-w-6xl mx-auto mb-4">
            <HarnessSessionPanel enabled />
          </div>
        ) : null}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <h3 className="text-sm font-semibold text-[var(--fg)] mb-1">Loading run details…</h3>
            <p className="text-xs text-[var(--muted-foreground-2)] max-w-md">
              Fetching the full diff payload for these runs.
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <h3 className="text-sm font-semibold text-[var(--fg)] mb-1">Run details unavailable</h3>
            <p className="text-xs text-[var(--muted-foreground-2)] max-w-md break-words">{error}</p>
          </div>
        ) : !activeRun ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <div className="size-10 text-[var(--muted-foreground-2)] flex items-center justify-center mb-3">
              <GitCompareArrows aria-hidden="true" className="w-6 h-6" strokeWidth={1.8} />
            </div>
            <h3 className="text-sm font-normal text-[var(--muted-foreground-2)]">No runs yet</h3>
          </div>
        ) : activeRun ? (
          <div className="max-w-6xl mx-auto flex flex-col gap-4">
            <SubagentTree runs={runs} onSelectRun={handleSelect} />
            <ReviewFindings key={activeRun.runId} threadId={activeRun.runId} sessionId={sessionId} />
            <div className="bg-[var(--card)] border border-[var(--border-1)] p-4 rounded-[var(--radius-button)] flex items-center justify-between gap-4 flex-wrap shadow-[var(--sh-card)]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-semibold text-sm text-[var(--fg)]">
                    {parseRepoName(activeRun.repoUrl)}
                  </span>
                  <span className="font-mono text-xs text-[var(--muted-foreground-2)]">
                    branch: {activeRun.baseBranch || "main"}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider border rounded-[var(--radius-button)] px-2 py-0.5 ${statusChipClass(
                      activeRun.status,
                    )}`}
                  >
                    {statusLabel(activeRun.status)}
                  </span>
                </div>
                <p className="text-xs text-[var(--muted-foreground-2)] truncate max-w-2xl">
                  {activeRun.task}
                </p>
              </div>

              <div className="text-right text-xs font-mono text-[var(--muted-foreground-2)]">
                <div>Run ID: {activeRun.runId}</div>
                <div>{formatTimeAgo(activeRun.createdAt)}</div>
              </div>
            </div>

            {activeDiff ? (
              <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] p-4 shadow-[var(--sh-card)]">
                <DiffViewer diff={activeDiff} runId={activeRun.runId} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-8 text-center">
                <div className="w-12 h-12 rounded-[var(--radius-button)] bg-[var(--bg)] border border-[var(--border-1)] text-[var(--muted-foreground-2)] flex items-center justify-center mb-3">
                  <FileText aria-hidden="true" className="w-6 h-6" strokeWidth={1.8} />
                </div>
                <h3 className="text-sm font-semibold text-[var(--fg)] mb-1">No diff yet</h3>
                <p className="text-xs text-[var(--muted-foreground-2)] max-w-md mb-4">
                  {activeRun.status === "running" || activeRun.status === "pending"
                    ? "This run is still writing files. The patch shows up here when it finishes."
                    : `This run is ${statusLabel(activeRun.status).toLowerCase()} and did not change any files.`}
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
