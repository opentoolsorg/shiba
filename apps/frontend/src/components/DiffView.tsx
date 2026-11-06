import { ChevronRight, FileText, GitCompareArrows, PanelLeft } from "lucide-react";
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
import { RunLivePanel } from "./RunLivePanel";
import { MainCard, type Scope } from "./ui/ContextPanel";

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
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
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
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
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

  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";

  return (
    <MainCard className={className}>
      {/* 48px Header */}
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              className="flex size-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              <li className="flex items-center gap-1.5 min-w-0">
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">{scopeLabel}</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">Insights</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <h1 className="text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate" aria-current="page">
                  Pull requests
                </h1>
              </li>
            </ol>
            <span className="ml-2 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-xs text-[#71717a] dark:text-zinc-400 tabular-nums">
              {runsWithDiff.length} with diffs / {runs.length} total
            </span>
          </nav>
        </div>

        {/* Run Selector */}
        {runs.length > 0 ? (
          <div className="flex items-center gap-2 shrink-0">
            <label htmlFor="diff-run-selector" className="text-xs text-[#71717a] dark:text-zinc-400">
              Run
            </label>
            <select
              id="diff-run-selector"
              aria-label="Select run for diff inspection"
              value={activeRun?.runId ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
              className="h-8 max-w-[min(20rem,60vw)] rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 truncate"
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
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-h-0 text-[#0a0a0a] dark:text-zinc-100">
        {liveHarness ? (
          <div className="max-w-6xl mx-auto mb-4">
            <HarnessSessionPanel enabled />
          </div>
        ) : null}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100 mb-1">Loading run details…</h3>
            <p className="text-xs text-[#71717a] dark:text-zinc-400 max-w-md">
              Fetching the full diff payload for these runs.
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <h3 className="text-sm font-semibold text-rose-600 dark:text-rose-400 mb-1">Run details unavailable</h3>
            <p className="text-xs text-[#71717a] dark:text-zinc-400 max-w-md break-words">{error}</p>
          </div>
        ) : !activeRun ? (
          <div className="flex flex-col items-center justify-center py-20 max-w-3xl mx-auto px-4 text-center">
            <div className="size-10 text-[#71717a] dark:text-zinc-400 flex items-center justify-center mb-3">
              <GitCompareArrows aria-hidden="true" className="w-6 h-6" strokeWidth={1.8} />
            </div>
            <h3 className="text-sm font-normal text-[#71717a] dark:text-zinc-400">No runs yet</h3>
          </div>
        ) : (
          <div className="max-w-6xl mx-auto flex flex-col gap-4">
            <SubagentTree runs={runs} onSelectRun={handleSelect} />
            <RunLivePanel
              key={`${sessionId ?? "default"}:${activeRun.runId}`}
              runId={activeRun.runId}
              sessionId={sessionId}
              showDiff
            />
            <ReviewFindings key={activeRun.runId} threadId={activeRun.runId} sessionId={sessionId} />

            <div className="bg-white dark:bg-zinc-900/60 border border-[#e4e4e7] dark:border-zinc-800 p-4 rounded-xl flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-semibold text-sm text-[#0a0a0a] dark:text-zinc-100">
                    {parseRepoName(activeRun.repoUrl)}
                  </span>
                  <span className="font-mono text-xs text-[#71717a] dark:text-zinc-400">
                    branch: {activeRun.baseBranch || "main"}
                  </span>
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider rounded-md px-2 py-0.5 ${statusChipClass(
                      activeRun.status,
                    )}`}
                  >
                    {statusLabel(activeRun.status)}
                  </span>
                </div>
                <p className="text-xs text-[#71717a] dark:text-zinc-400 truncate max-w-2xl">
                  {activeRun.task}
                </p>
              </div>

              <div className="text-right text-xs font-mono text-[#71717a] dark:text-zinc-400">
                <div>Run ID: {activeRun.runId}</div>
                <div>{formatTimeAgo(activeRun.createdAt)}</div>
              </div>
            </div>

            {activeDiff ? (
              <div className="bg-white dark:bg-zinc-900/60 border border-[#e4e4e7] dark:border-zinc-800 rounded-xl p-4">
                <DiffViewer diff={activeDiff} runId={activeRun.runId} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[#e4e4e7] dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900/40 p-8 text-center">
                <div className="w-12 h-12 rounded-xl bg-[#f4f4f5] dark:bg-zinc-800 text-[#71717a] dark:text-zinc-400 flex items-center justify-center mb-3">
                  <FileText aria-hidden="true" className="w-6 h-6" strokeWidth={1.8} />
                </div>
                <h3 className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100 mb-1">No diff yet</h3>
                <p className="text-xs text-[#71717a] dark:text-zinc-400 max-w-md mb-4">
                  {activeRun.status === "running" || activeRun.status === "pending"
                    ? "This run is still writing files. The patch shows up here when it finishes."
                    : `This run is ${statusLabel(activeRun.status).toLowerCase()} and did not change any files.`}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </MainCard>
  );
}
