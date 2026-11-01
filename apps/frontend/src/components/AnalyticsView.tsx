/**
 * AnalyticsView — Costs-style usage page over the retained run registry
 * (`GET /api/runs` → DelegatedRun[]). Every metric is computed from fields
 * that actually exist on the run record; anything the backend does not
 * track (token counts, USD cost) is an honest empty state, never fabricated.
 */
import { useMemo, type JSX } from "react";
import { Plus } from "lucide-react";
import { ViewEmpty, ViewGroup, ViewHeader, viewButtonClass } from "./ui/ViewChrome";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { ToneChip } from "./ToneChip";
import {
  useUsageReport,
  type UsageDayWire,
  type UsageGroupWire,
  type UsageReportWire,
} from "../live-status";
import { formatRunUsageLine } from "./RunUsageSummary";
import type { RetainedRun } from "../types";
import {
  ERROR_FAMILY_STATUSES,
  formatTimeAgo,
  parseRepoName,
  statusChipClass,
  statusLabel,
} from "../ui-helpers";

function isTerminal(status: string): boolean {
  return status === "completed" || ERROR_FAMILY_STATUSES.has(status);
}

function runDurationMs(run: RetainedRun): number | null {
  if (!isTerminal(run.status) || run.createdAt <= 0 || run.updatedAt <= run.createdAt) return null;
  return run.updatedAt - run.createdAt;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="border-b border-[var(--border-1)] bg-[var(--bg)] px-4 py-4">
      <p className="text-xs font-medium text-[var(--muted-foreground-2)]">{label}</p>
      <p className="mt-1.5 font-sans text-xl text-[var(--fg)]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[var(--muted-foreground-2)]">{sub}</p>
    </div>
  );
}

/** Count breakdown rendered as labeled meter rows (no chart lib in this repo). */
function BreakdownCard({
  title,
  hint,
  rows,
  empty,
}: {
  title: string;
  hint: string;
  rows: { label: string; count: number }[];
  empty: string;
}): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="border-b border-[var(--border-1)] bg-[var(--bg)]">
      <ViewGroup title={title} count={rows.reduce((sum, row) => sum + row.count, 0)}>
      <p className="px-3 pb-3 text-xs text-[var(--muted-foreground-2)]">{hint}</p>
      {rows.length === 0 ? (
        <ViewEmpty>{empty}</ViewEmpty>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-3">
          {rows.map((row) => (
            <div key={row.label} className="flex min-h-11 items-center gap-3 border-b border-[var(--border-1)]">
              <span className="w-36 shrink-0 truncate font-mono text-[11px] text-[var(--fg)]" title={row.label}>
                {row.label}
              </span>
              <div className="h-2.5 flex-1 bg-[var(--secondary)]">
                <div
                  className="h-full bg-[var(--primary)]"
                  style={{ width: `${Math.round((row.count / max) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[var(--muted-foreground-2)]">{row.count}</span>
            </div>
          ))}
        </div>
      )}
      </ViewGroup>
    </section>
  );
}

function countsBy(runs: RetainedRun[], key: (run: RetainedRun) => string): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const run of runs) {
    const label = key(run);
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export function AnalyticsView({
  runs,
  error,
  onNavigate,
  sessionId,
  sessionApiAvailable,
}: {
  runs: RetainedRun[];
  error?: string | null;
  onNavigate?: (view: AppNavView) => void;
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const stats = useMemo(() => {
    const terminal = runs.filter((run) => isTerminal(run.status));
    const completed = runs.filter((run) => run.status === "completed");
    const failed = runs.filter((run) => ERROR_FAMILY_STATUSES.has(run.status));
    const active = runs.filter((run) => run.status === "pending" || run.status === "running");
    const durations = runs.map(runDurationMs).filter((ms): ms is number => ms !== null);
    const avg = durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) / durations.length : null;
    const prs = runs.filter((run) => typeof run.pullUrl === "string" && run.pullUrl !== "");
    return {
      total: runs.length,
      terminal: terminal.length,
      completed: completed.length,
      failed: failed.length,
      active: active.length,
      avgDurationMs: avg,
      prs: prs.length,
    };
  }, [runs]);

  const byHarness = useMemo(
    () => countsBy(runs, (run) => run.route?.harness ?? "not recorded"),
    [runs],
  );
  const byModel = useMemo(
    () => countsBy(runs, (run) => run.route?.modelId ?? "not recorded"),
    [runs],
  );
  const byRuntime = useMemo(
    () => countsBy(runs, (run) => run.runtime ?? "sandbox"),
    [runs],
  );
  const byRepo = useMemo(
    () => countsBy(runs, (run) => parseRepoName(run.repoUrl)).slice(0, 6),
    [runs],
  );

  const tableRuns = useMemo(
    () => [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
    [runs],
  );

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <ViewHeader section="Analytics" view="Overview" count={`${runs.length} runs`}>
        {onNavigate ? <button type="button" onClick={() => onNavigate("tasks")} className={viewButtonClass}><Plus aria-hidden="true" className="size-4" />New task</button> : null}
      </ViewHeader>
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {error ? <LoadErrorState message={error} onRetry={() => window.location.reload()} /> : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Total runs" value={String(stats.total)} sub="Retained runs" />
            <MetricCard
              label="Completed"
              value={String(stats.completed)}
              sub={stats.terminal > 0 ? `${Math.round((stats.completed / stats.terminal) * 100)}% of terminal runs` : "No terminal runs yet"}
            />
            <MetricCard
              label="Error family"
              value={String(stats.failed)}
              sub={stats.terminal > 0 ? `${Math.round((stats.failed / stats.terminal) * 100)}% of terminal runs` : "error · aborted · cancelled · unknown"}
            />
            <MetricCard label="Active now" value={String(stats.active)} sub="Pending + running" />
            <MetricCard
              label="Avg duration"
              value={stats.avgDurationMs !== null ? formatDuration(stats.avgDurationMs) : "—"}
              sub="Finished runs only"
            />
            <MetricCard label="PRs opened" value={String(stats.prs)} sub="Runs with a PR link" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BreakdownCard
              title="Runs by harness"
              hint="Recorded harness; older runs may not include one"
              rows={byHarness}
              empty="No runs yet"
            />
            <BreakdownCard
              title="Runs by model"
              hint="Model selected at approval"
              rows={byModel}
              empty="No runs yet"
            />
            <BreakdownCard
              title="Runtime"
              hint="Sandbox and local runs"
              rows={byRuntime}
              empty="No runs yet"
            />
            <BreakdownCard
              title="Top repositories"
              hint="By run count across the registry"
              rows={byRepo}
              empty="No runs yet"
            />
          </div>

          <UsageSection sessionId={sessionId} sessionApiAvailable={sessionApiAvailable} />

          <section className="border-b border-[var(--border-1)] bg-[var(--bg)]">
            <header className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2.5">
              <div>
                <h3 className="text-xs font-semibold text-[var(--fg)]">Runs</h3>
                <p className="text-[11px] text-[var(--muted-foreground-2)]">
                  {tableRuns.length === runs.length
                    ? `${runs.length} run${runs.length === 1 ? "" : "s"}`
                    : `Latest ${tableRuns.length} of ${runs.length}`}
                </p>
              </div>

            </header>
            {tableRuns.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <ViewEmpty>No runs yet</ViewEmpty>
                {onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate("tasks")}
                    className={viewButtonClass}
                  >
                    New task
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border-1)] text-xs font-medium text-[var(--muted-foreground-2)]">
                      <th className="px-4 py-2 font-semibold">Run</th>
                      <th className="px-4 py-2 font-semibold">Repository</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Harness</th>
                      <th className="px-4 py-2 font-semibold">Runtime</th>
                      <th className="px-4 py-2 font-semibold">Duration</th>
                      <th className="px-4 py-2 font-semibold">Usage</th>
                      <th className="px-4 py-2 font-semibold">Created</th>
                      <th className="px-4 py-2 font-semibold">PR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRuns.map((run) => {
                      const duration = runDurationMs(run);
                      return (
                        <tr key={run.runId} className="h-11 border-b border-[var(--border-1)] last:border-b-0 hover:bg-[var(--card-hover)]">
                          <td className="px-4 py-2">
                            <div className="font-mono text-[11px] text-[var(--fg)]">{run.runId.slice(0, 8)}</div>
                            <div className="max-w-56 truncate text-[11px] text-[var(--muted-foreground-2)]" title={run.task}>
                              {run.task}
                            </div>
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]">{parseRepoName(run.repoUrl)}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-block rounded-[var(--radius-button)] border px-2 py-0.5 text-[11px] font-medium ${statusChipClass(run.status)}`}>
                              {statusLabel(run.status)}
                            </span>
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]">{run.route?.harness ?? "—"}</td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]">{run.runtime ?? "sandbox"}</td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]">
                            {duration !== null ? formatDuration(duration) : run.status === "running" || run.status === "pending" ? "in flight" : "—"}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]" data-testid="run-usage-cell">
                            {formatRunUsageLine(run) ?? "—"}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--muted-foreground-2)]">{formatTimeAgo(run.createdAt)}</td>
                          <td className="px-4 py-2">
                            {run.pullUrl ? (
                              <a
                                href={run.pullUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-h-11 items-center rounded px-2 text-xs font-medium text-[var(--fg)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                              >
                                Open PR
                              </a>
                            ) : (
                              <span className="font-mono text-[11px] text-[var(--muted-foreground-2)]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[11px] text-[var(--muted-foreground-2)]">
            Statuses roll up the registry vocabulary — <ToneChip tone="ok" label="completed" /> counts toward the
            success rate; error, aborted, cancelled, and unknown count toward the error family.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Compact token count — an absent field renders "—", never a fabricated zero. */
function tokenCount(n: number | undefined): string {
  return n === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function usdCost(n: number | undefined): string {
  if (n === undefined) return "—";
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function tokenTotalLabel(input: number | undefined, output: number | undefined): string {
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${tokenCount(input)} in`);
  if (output !== undefined) parts.push(`${tokenCount(output)} out`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}

/** Sum a day's worth of reports; a field appears only if some day carried it. */
function usageTotals(days: UsageDayWire[]): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const totals: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
  for (const day of days) {
    if (day.inputTokens !== undefined) totals.inputTokens = (totals.inputTokens ?? 0) + day.inputTokens;
    if (day.outputTokens !== undefined) totals.outputTokens = (totals.outputTokens ?? 0) + day.outputTokens;
    if (day.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + day.costUsd;
  }
  return totals;
}

/** Merge per-day groups across the window into one row per harness/provider/role. */
function mergeUsageGroups(days: UsageDayWire[]): UsageGroupWire[] {
  const merged = new Map<string, UsageGroupWire>();
  for (const day of days) {
    for (const group of day.groups) {
      const key = `${group.harness ?? ""}${group.provider ?? ""}${group.role ?? ""}`;
      const row = merged.get(key) ?? {
        harness: group.harness,
        provider: group.provider,
        role: group.role,
        runs: 0,
      };
      row.runs += group.runs;
      if (group.inputTokens !== undefined) row.inputTokens = (row.inputTokens ?? 0) + group.inputTokens;
      if (group.outputTokens !== undefined) row.outputTokens = (row.outputTokens ?? 0) + group.outputTokens;
      if (group.costUsd !== undefined) row.costUsd = (row.costUsd ?? 0) + group.costUsd;
      merged.set(key, row);
    }
  }
  return [...merged.values()].sort((a, b) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0));
}

/**
 * Token usage & budget — the daily aggregates `GET /api/usage` computes over
 * the retained run store. Buckets are UTC days (the wire says so); every
 * number is only what a harness stream reported, so a run that never emits
 * usage contributes nothing and a field that no run reported stays "—".
 */
function UsageSection({
  sessionId,
  sessionApiAvailable,
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const usage = useUsageReport(sessionId, sessionApiAvailable);
  return (
    <section className="border-b border-[var(--border-1)] bg-[var(--bg)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2.5">
        <div>
          <h3 className="text-xs font-semibold text-[var(--fg)]">Token usage &amp; budget</h3>
          <p className="text-[11px] text-[var(--muted-foreground-2)]">
            Harness-reported usage by day, in UTC.
          </p>
        </div>
        {usage.state.kind === "data" || usage.state.kind === "error" ? (
          <button
            type="button"
            onClick={usage.reload}
            className={viewButtonClass}
          >
            Refresh
          </button>
        ) : null}
      </header>
      {usage.state.kind === "loading" ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Loading usage…</div>
      ) : usage.state.kind === "error" ? (
        <div className="px-4 py-3">
          <LoadErrorState message={usage.state.message} onRetry={usage.reload} />
        </div>
      ) : (
        <UsageReportBody report={usage.state.data} />
      )}
    </section>
  );
}

function UsageReportBody({ report }: { report: UsageReportWire }): JSX.Element {
  // The backend buckets by UTC day — "today" is the same UTC day.
  const todayKey = new Date().toISOString().slice(0, 10);
  const weekStartKey = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekDays = report.days.filter((day) => day.date >= weekStartKey);
  const today = report.days.find((day) => day.date === todayKey);
  const week = usageTotals(weekDays);
  const groups = mergeUsageGroups(weekDays);
  const spentToday = today?.costUsd;
  const budget = report.budgetUsd;
  const spentPct =
    budget !== null && budget > 0 && spentToday !== undefined
      ? Math.min(100, (spentToday / budget) * 100)
      : 0;

  if (report.days.length === 0) {
    return (
      <ViewEmpty>No token usage reported yet</ViewEmpty>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Tokens · today"
          value={tokenTotalLabel(today?.inputTokens, today?.outputTokens)}
          sub={today !== undefined ? `${today.runs} run${today.runs === 1 ? "" : "s"} reported` : "Nothing reported today"}
        />
        <MetricCard
          label="Tokens · 7 days"
          value={tokenTotalLabel(week.inputTokens, week.outputTokens)}
          sub={`${weekDays.reduce((sum, day) => sum + day.runs, 0)} run${weekDays.reduce((sum, day) => sum + day.runs, 0) === 1 ? "" : "s"} reported`}
        />
        <MetricCard
          label="Cost · today"
          value={usdCost(today?.costUsd)}
          sub="Reported by the harness, not estimated"
        />
        <MetricCard
          label="Cost · 7 days"
          value={usdCost(week.costUsd)}
          sub="Reported by the harness, not estimated"
        />
      </div>

      {budget !== null ? (
        <div className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold text-[var(--fg)]">Daily budget</span>
            <span className="font-mono text-[11px] text-[var(--muted-foreground-2)]">
              {spentToday === undefined ? "no spend reported" : usdCost(spentToday)} of {usdCost(budget)}
            </span>
          </div>
          <div className="mt-2 h-2 border border-[var(--border-1)] bg-[var(--secondary)]">
            <div
              className={`h-full ${spentToday !== undefined && spentToday > budget ? "bg-[var(--destructive)]" : "bg-[var(--primary-soft-hover)]"}`}
              style={{ width: `${spentPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--muted-foreground-2)]">
            USAGE_BUDGET_USD — today&apos;s reported cost against the configured daily budget.
          </p>
        </div>
      ) : null}

      <div>
        <p className="text-xs font-medium text-[var(--muted-foreground-2)]">
          Per harness · last 7 days
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {groups.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground-2)]">No usage in the last 7 days.</p>
          ) : (
            groups.map((group) => (
              <div
                key={`${group.harness ?? ""}/${group.provider ?? ""}/${group.role ?? ""}`}
                className="flex items-baseline justify-between gap-3 border-b border-[var(--border-1)] pb-2 last:border-b-0"
              >
                <span className="font-mono text-[11px] text-[var(--fg)]">
                  {group.harness ?? "not recorded"}
                  {group.provider !== null ? <span className="text-[var(--muted-foreground-2)]"> · {group.provider}</span> : null}
                  {group.role !== null ? <span className="text-[var(--muted-foreground-2)]"> · {group.role}</span> : null}
                </span>
                <span className="text-right font-mono text-[11px] text-[var(--muted-foreground-2)]">
                  {tokenTotalLabel(group.inputTokens, group.outputTokens)}
                  {group.costUsd !== undefined ? ` · ${usdCost(group.costUsd)}` : ""}
                  {` · ${group.runs} run${group.runs === 1 ? "" : "s"}`}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
