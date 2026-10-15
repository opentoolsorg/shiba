/**
 * T-activity: fold retained run records into the workspace activity report
 * for `GET /api/activity`. Pure math over `DelegatedRun[]` — the route
 * handler fetches the records from the orchestrator DO and passes them here.
 *
 * Metrics bucket runs by `createdAt` over a half-open [from, to) period
 * plus the same-length window immediately before it ("now" vs "last"). The
 * contribution heatmap ignores the period — it always spans the last
 * CONTRIBUTION_DAYS UTC days ending today. runtime/project/member filters
 * apply to metrics, contribution, and pullRequests; the projects/members
 * pick lists are computed over all runs so filter dropdowns stay populated.
 */
import type { DelegatedRun } from "@shiba/shared";
import { isTerminalStatus } from "@shiba/shared";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const ACTIVITY_DAYS_DEFAULT = 30;
export const ACTIVITY_DAYS_ALLOWED: readonly number[] = [7, 30, 90];
export const ACTIVITY_RANGE_MAX_MS = 365 * DAY_MS;
export const CONTRIBUTION_DAYS = 364;

export interface ActivityMetric {
  now: number | null;
  last: number | null;
}

export interface ActivityWindow {
  from: number;
  to: number;
}

export type ActivityRuntimeFilter = "all" | "cloud" | "local";

export interface ActivityFilters {
  runtime?: ActivityRuntimeFilter;
  /** Exact repoUrl match; absent or empty means no project filter. */
  project?: string | null;
  /** Exact queuedBy match; absent or empty means no member filter. */
  member?: string | null;
}

export interface ActivityReport {
  generatedAt: number;
  period: ActivityWindow;
  previous: ActivityWindow;
  /** Distinct repoUrl over every retained run, sorted — never filtered. */
  projects: string[];
  /** Distinct non-empty queuedBy over every retained run, sorted. */
  members: string[];
  metrics: {
    contribution: ActivityMetric;
    issuesDetected: ActivityMetric;
    prsContributed: ActivityMetric;
    prsMerged: ActivityMetric;
    feedbackLoops: ActivityMetric;
    agentHours: ActivityMetric;
  };
  contribution: { date: string; count: number }[];
  pullRequests: {
    total: { date: string; count: number }[];
    byMember: { member: string; count: number }[];
  };
}

/** `?days=` — only the preset windows; anything else falls back to the default. */
export function parseActivityDays(raw: string | null): number {
  const parsed = raw === null ? ACTIVITY_DAYS_DEFAULT : Number(raw);
  return ACTIVITY_DAYS_ALLOWED.includes(parsed) ? parsed : ACTIVITY_DAYS_DEFAULT;
}

/** `?runtime=` — "cloud" is anything but the local daemon (missing = sandbox). */
export function parseActivityRuntime(raw: string | null): ActivityRuntimeFilter {
  return raw === "cloud" || raw === "local" ? raw : "all";
}

/**
 * The report window: `?from`/`?to` epoch-ms bound a custom range (span
 * capped at a year); otherwise `?days` picks a preset window ending at
 * `now`. A malformed range returns an error string the route turns into
 * a 400 — a half-specified custom range is a caller bug, not a default.
 */
export function parseActivityPeriod(
  params: URLSearchParams,
  now: number,
): ActivityWindow | { error: string } {
  if (params.has("from") || params.has("to")) {
    const rawFrom = params.get("from");
    const rawTo = params.get("to");
    const from = rawFrom === null ? NaN : Number(rawFrom);
    const to = rawTo === null ? NaN : Number(rawTo);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > ACTIVITY_RANGE_MAX_MS
    ) {
      return {
        error:
          "Invalid range: from and to must be epoch milliseconds with from < to spanning at most 365 days.",
      };
    }
    return { from, to };
  }
  const days = parseActivityDays(params.get("days"));
  return { from: now - days * DAY_MS, to: now };
}

/** Failed terminal runs; an operator cancel is a choice, not an issue. */
function isErrorFamily(status: DelegatedRun["status"]): boolean {
  return isTerminalStatus(status) && status !== "completed" && status !== "cancelled";
}

// Archiving bumps updatedAt without a receipt, so the last receipt marks the real end.
function runEndedAt(run: DelegatedRun): number {
  return run.archivedAt === undefined ? run.updatedAt : (run.receipts?.at(-1)?.at ?? run.createdAt);
}

function matchesFilters(run: DelegatedRun, filters: ActivityFilters): boolean {
  const runtime = filters.runtime ?? "all";
  if (runtime === "local" && run.runtime !== "local") return false;
  if (runtime === "cloud" && run.runtime === "local") return false;
  if (filters.project && run.repoUrl !== filters.project) return false;
  if (filters.member && run.queuedBy !== filters.member) return false;
  return true;
}

function inWindow(run: DelegatedRun, window: ActivityWindow): boolean {
  return run.createdAt >= window.from && run.createdAt < window.to;
}

/** Sum a per-run value into the current vs previous bucket by createdAt. */
function bucketed(
  runs: DelegatedRun[],
  period: ActivityWindow,
  previous: ActivityWindow,
  value: (run: DelegatedRun) => number,
): ActivityMetric {
  let now = 0;
  let last = 0;
  for (const run of runs) {
    const contribution = value(run);
    if (contribution === 0) continue;
    if (inWindow(run, period)) now += contribution;
    else if (inWindow(run, previous)) last += contribution;
  }
  return { now, last };
}

function utcDayStart(epoch: number): number {
  const d = new Date(epoch);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcDayLabel(dayStart: number): string {
  return new Date(dayStart).toISOString().slice(0, 10);
}

export function buildActivityReport(
  runs: DelegatedRun[],
  opts?: ActivityFilters & { period?: ActivityWindow; now?: number },
): ActivityReport {
  const now = opts?.now ?? Date.now();
  const period = opts?.period ?? { from: now - ACTIVITY_DAYS_DEFAULT * DAY_MS, to: now };
  const span = period.to - period.from;
  const previous: ActivityWindow = { from: period.from - span, to: period.from };
  const filtered = runs.filter((run) => matchesFilters(run, opts ?? {}));

  const agentHoursIn = (window: ActivityWindow): number => {
    let ms = 0;
    for (const run of filtered) {
      if (isTerminalStatus(run.status) && inWindow(run, window)) {
        ms += Math.max(0, runEndedAt(run) - run.createdAt);
      }
    }
    return Math.round((ms / HOUR_MS) * 10) / 10;
  };

  // GitHub-style heatmap: the last CONTRIBUTION_DAYS UTC days, period-blind.
  const todayStart = utcDayStart(now);
  const firstHeatmapDay = todayStart - (CONTRIBUTION_DAYS - 1) * DAY_MS;
  const heatmapCounts = new Map<string, number>();
  for (const run of filtered) {
    if (run.createdAt < firstHeatmapDay || run.createdAt >= todayStart + DAY_MS) continue;
    const date = utcDayLabel(utcDayStart(run.createdAt));
    heatmapCounts.set(date, (heatmapCounts.get(date) ?? 0) + 1);
  }
  const contribution: { date: string; count: number }[] = [];
  for (let d = firstHeatmapDay; d <= todayStart; d += DAY_MS) {
    const date = utcDayLabel(d);
    contribution.push({ date, count: heatmapCounts.get(date) ?? 0 });
  }

  // One bar per UTC calendar day the current period touches.
  const prDayCounts = new Map<string, number>();
  const prByMember = new Map<string, number>();
  for (const run of filtered) {
    if (!run.pullUrl || !inWindow(run, period)) continue;
    const date = utcDayLabel(utcDayStart(run.createdAt));
    prDayCounts.set(date, (prDayCounts.get(date) ?? 0) + 1);
    const member = run.queuedBy || "unknown";
    prByMember.set(member, (prByMember.get(member) ?? 0) + 1);
  }
  const prTotal: { date: string; count: number }[] = [];
  for (let d = utcDayStart(period.from); d < period.to; d += DAY_MS) {
    const date = utcDayLabel(d);
    prTotal.push({ date, count: prDayCounts.get(date) ?? 0 });
  }

  return {
    generatedAt: now,
    period,
    previous,
    projects: [...new Set(runs.map((run) => run.repoUrl))].sort((a, b) => a.localeCompare(b)),
    members: [
      ...new Set(runs.map((run) => run.queuedBy).filter((m): m is string => Boolean(m))),
    ].sort((a, b) => a.localeCompare(b)),
    metrics: {
      contribution: bucketed(filtered, period, previous, (run) =>
        run.status === "completed" ? 1 : 0,
      ),
      issuesDetected: bucketed(filtered, period, previous, (run) =>
        isErrorFamily(run.status) ? 1 : 0,
      ),
      prsContributed: bucketed(filtered, period, previous, (run) => (run.pullUrl ? 1 : 0)),
      // Merge state is not tracked on run records — nothing to report.
      prsMerged: { now: null, last: null },
      feedbackLoops: bucketed(filtered, period, previous, (run) => run.steering?.length ?? 0),
      agentHours: { now: agentHoursIn(period), last: agentHoursIn(previous) },
    },
    contribution,
    pullRequests: {
      total: prTotal,
      byMember: [...prByMember.entries()]
        .map(([member, count]) => ({ member, count }))
        .sort((a, b) => b.count - a.count || a.member.localeCompare(b.member)),
    },
  };
}
