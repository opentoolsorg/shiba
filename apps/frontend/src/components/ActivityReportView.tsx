/**
 * Workspace activity report — KPI strip, a 52-week contribution heatmap, and
 * the agent's pull-request output over GET /api/activity. Filters rebuild the
 * query string; null metrics render as "—" rather than fabricated zeros.
 *
 * Restyled into main card: 48px header with breadcrumb "Scope > Insights > Activity report",
 * neutral card styling.
 */
import { useMemo, useState, type JSX } from "react";
import { ChevronRight, PanelLeft } from "lucide-react";
import { bucketContributionWeeks, contributionLevel } from "../activity-heatmap";
import {
  type ActivityMetricWire,
  type ActivityReportQuery,
  type ActivityReportWire,
  useActivityReport,
} from "../live-status";
import { parseRepoName } from "../ui-helpers";
import { LoadErrorState } from "./LoadErrorState";
import { ViewEmpty, ViewGroup } from "./ui/ViewChrome";
import { MainCard, type Scope } from "./ui/ContextPanel";

type Period = "7" | "30" | "90" | "custom";
type RuntimeFilter = "all" | "cloud" | "local";

const DAY_MS = 86_400_000;
const CELL_PX = 10;
const GAP_PX = 3;
const ROW_LABEL_PX = 24;
const WEEKS = 52;

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "custom", label: "Custom" },
];

const RUNTIME_OPTIONS: { value: RuntimeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "cloud", label: "Cloud" },
  { value: "local", label: "Local" },
];

const LEVEL_CLASSES = [
  "bg-[#f4f4f5] dark:bg-zinc-800",
  "bg-zinc-300 dark:bg-zinc-700",
  "bg-zinc-400 dark:bg-zinc-600",
  "bg-zinc-600 dark:bg-zinc-400",
  "bg-zinc-900 dark:bg-zinc-100",
] as const;

const formatInt = (n: number): string => Math.round(n).toLocaleString("en-US");
const formatHours = (n: number): string => `${Number.isInteger(n) ? String(n) : n.toFixed(1)}h`;

const METRICS: {
  key: keyof ActivityReportWire["metrics"];
  label: string;
  format: (n: number) => string;
}[] = [
  { key: "contribution", label: "Contribution", format: formatInt },
  { key: "issuesDetected", label: "Issues detected", format: formatInt },
  { key: "prsContributed", label: "PRs contributed to", format: formatInt },
  { key: "prsMerged", label: "PRs merged", format: formatInt },
  { key: "feedbackLoops", label: "Feedback loops", format: formatInt },
  { key: "agentHours", label: "Agent hours", format: formatHours },
];

const FILTER_INPUT_CLASS =
  "h-8 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100";

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 items-center gap-0.5 rounded-lg bg-[#f4f4f5] p-0.5 dark:bg-zinc-800/80"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={
            "flex h-7 items-center justify-center rounded px-2.5 text-[12px] font-medium transition-all " +
            (value === option.value
              ? "bg-white text-[#0a0a0a] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:text-zinc-100"
              : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200")
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CompareBar({
  label,
  fraction,
  active,
}: {
  label: string;
  fraction: number;
  active?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-6 text-[9px] uppercase tracking-wide text-[#71717a] dark:text-zinc-400">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#f4f4f5] dark:bg-zinc-800">
        <div
          className={
            active
              ? "h-full rounded-full bg-zinc-900 dark:bg-zinc-100"
              : "h-full rounded-full bg-zinc-400 dark:bg-zinc-600"
          }
          style={{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function KpiCell({
  label,
  metric,
  format,
}: {
  label: string;
  metric: ActivityMetricWire;
  format: (n: number) => string;
}): JSX.Element {
  const now = metric.now ?? 0;
  const last = metric.last ?? 0;
  const max = Math.max(now, last);
  return (
    <div className="bg-white p-4 dark:bg-zinc-900/60">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-[#0a0a0a] dark:text-zinc-100">
        {metric.now === null ? "—" : format(metric.now)}
      </p>
      {max <= 0 ? (
        <div className="my-2 border-t border-dashed border-[#e4e4e7] dark:border-zinc-800" />
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          <CompareBar label="Now" fraction={now / max} active />
          <CompareBar label="Last" fraction={last / max} />
        </div>
      )}
      <p className="mt-2 text-[11px] text-[#71717a] dark:text-zinc-400">
        {metric.last === null ? "No last period" : `${format(metric.last)} vs last period`}
      </p>
    </div>
  );
}

const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ContributionSection({ days }: { days: { date: string; count: number }[] }): JSX.Element {
  const grid = useMemo(() => bucketContributionWeeks(days, WEEKS), [days]);
  const max = useMemo(() => Math.max(0, ...days.map((day) => day.count)), [days]);
  const total = useMemo(
    () => grid.columns.reduce((sum, column) => sum + column.days.reduce((s, day) => s + (day?.count ?? 0), 0), 0),
    [grid],
  );

  return (
    <section className="rounded-xl border border-[#e4e4e7] bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <ViewGroup title="Contribution" count={total}>
        <div className="overflow-x-auto px-4 py-4">
          <div className="w-max">
            <div className="mb-1 flex" style={{ gap: GAP_PX, paddingLeft: ROW_LABEL_PX + GAP_PX }}>
              {grid.columns.map((column) => (
                <div
                  key={column.key}
                  className="shrink-0 overflow-visible whitespace-nowrap text-[9px] leading-none text-[#71717a] dark:text-zinc-400"
                  style={{ width: CELL_PX }}
                >
                  {column.monthLabel}
                </div>
              ))}
            </div>
            <div
              role="img"
              aria-label="Contribution activity over the last 52 weeks"
              className="flex"
              style={{ gap: GAP_PX }}
            >
              <div className="flex shrink-0 flex-col" style={{ gap: GAP_PX, width: ROW_LABEL_PX }}>
                {DOW_NAMES.map((name, index) => (
                  <div
                    key={name}
                    className="text-[9px] leading-none text-[#71717a] dark:text-zinc-400"
                    style={{ height: CELL_PX }}
                  >
                    {index % 2 === 0 && index < 6 ? name : ""}
                  </div>
                ))}
              </div>
              {grid.columns.map((column) => (
                <div key={column.key} className="flex shrink-0 flex-col" style={{ gap: GAP_PX }}>
                  {column.days.map((cell, dayIndex) => (
                    <div
                      key={cell?.date ?? `${column.key}-${dayIndex}`}
                      title={cell ? `${cell.count} runs on ${cell.date}` : undefined}
                      className={
                        "rounded-[2px] " +
                        (cell === null
                          ? "bg-[#f4f4f5]/50 dark:bg-zinc-800/40"
                          : LEVEL_CLASSES[contributionLevel(cell.count, max)])
                      }
                      style={{ width: CELL_PX, height: CELL_PX }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-[#e4e4e7] pt-3 text-[11px] text-[#71717a] dark:border-zinc-800 dark:text-zinc-400">
          <span>{formatInt(total)} touches in the last 52 weeks</span>
          <span className="flex items-center gap-1.5">
            Less
            {LEVEL_CLASSES.map((cls) => (
              <span
                key={cls}
                className={`inline-block rounded-[2px] ${cls}`}
                style={{ width: CELL_PX, height: CELL_PX }}
              />
            ))}
            More
          </span>
        </footer>
      </ViewGroup>
    </section>
  );
}

function DailyPrBars({ days }: { days: { date: string; count: number }[] }): JSX.Element {
  const max = Math.max(1, ...days.map((day) => day.count));
  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="flex h-28 items-end gap-[2px]">
        {days.map((day) => (
          <div
            key={day.date}
            title={`${day.count} pull requests on ${day.date}`}
            className={
              "min-w-[4px] flex-1 rounded-t-[2px] " +
              (day.count > 0 ? "bg-zinc-900 dark:bg-zinc-100" : "bg-[#f4f4f5] dark:bg-zinc-800")
            }
            style={{ height: `${Math.max(2, (day.count / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function MemberPrBars({ rows }: { rows: { member: string; count: number }[] }): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...sorted.map((row) => row.count));
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {sorted.map((row) => (
        <div key={row.member} className="flex min-h-10 items-center gap-3 border-b border-[#e4e4e7] dark:border-zinc-800/80 last:border-b-0 py-1">
          <span
            className="w-36 shrink-0 truncate font-mono text-[11px] text-[#0a0a0a] dark:text-zinc-200"
            title={row.member}
          >
            {row.member}
          </span>
          <div className="h-2 flex-1 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-zinc-900 dark:bg-zinc-100"
              style={{ width: `${Math.round((row.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[#71717a] dark:text-zinc-400">
            {row.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function PullRequestsSection({
  pullRequests,
}: {
  pullRequests: ActivityReportWire["pullRequests"];
}): JSX.Element {
  const [view, setView] = useState<"total" | "member">("total");
  const totalCount = pullRequests.total.reduce((sum, day) => sum + day.count, 0);
  const empty = totalCount === 0 && pullRequests.byMember.length === 0;
  return (
    <section className="rounded-xl border border-[#e4e4e7] bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-900/40">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e4e7] px-4 py-3 dark:border-zinc-800">
        <h3 className="text-xs font-semibold text-[#0a0a0a] dark:text-zinc-100">
          Agent pull requests
        </h3>
        <SegmentedControl
          label="Pull request breakdown"
          options={[
            { value: "total", label: "Total" },
            { value: "member", label: "By member" },
          ]}
          value={view}
          onChange={setView}
        />
      </header>
      {empty || (view === "member" && pullRequests.byMember.length === 0) ? (
        <ViewEmpty>No pull requests in this period</ViewEmpty>
      ) : view === "total" ? (
        <DailyPrBars days={pullRequests.total} />
      ) : (
        <MemberPrBars rows={pullRequests.byMember} />
      )}
    </section>
  );
}

function ReportSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" className="flex animate-pulse flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {["m1", "m2", "m3", "m4", "m5", "m6"].map((key) => (
          <div key={key} className="h-24 rounded-xl bg-[#f4f4f5] dark:bg-zinc-800" />
        ))}
      </div>
      <div className="h-44 rounded-xl bg-[#f4f4f5] dark:bg-zinc-800" />
      <div className="h-48 rounded-xl bg-[#f4f4f5] dark:bg-zinc-800" />
    </div>
  );
}

export function ActivityReportView({
  sessionId,
  sessionApiAvailable,
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}): JSX.Element {
  const [period, setPeriod] = useState<Period>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [runtime, setRuntime] = useState<RuntimeFilter>("all");
  const [project, setProject] = useState("all");
  const [member, setMember] = useState("all");

  const query = useMemo<ActivityReportQuery>(() => {
    const start = Date.parse(customFrom);
    const end = Date.parse(customTo);
    const custom =
      period === "custom" &&
      new Date(start).getUTCFullYear() >= 2000 &&
      new Date(end).getUTCFullYear() >= 2000 &&
      Math.abs(end - start) < 365 * DAY_MS;
    if (custom) {
      return {
        runtime,
        from: Math.min(start, end),
        to: Math.max(start, end) + DAY_MS,
        ...(project !== "all" ? { project } : {}),
        ...(member !== "all" ? { member } : {}),
      };
    }
    return {
      runtime,
      days: period === "custom" ? 30 : Number(period),
      ...(project !== "all" ? { project } : {}),
      ...(member !== "all" ? { member } : {}),
    };
  }, [period, customFrom, customTo, runtime, project, member]);

  const { state, reload } = useActivityReport(sessionId, sessionApiAvailable, query);
  const report = state.kind === "data" ? state.data : null;
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
                  Activity report
                </h1>
              </li>
            </ol>
            {report ? (
              <span className="ml-2 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-xs text-[#71717a] dark:text-zinc-400 tabular-nums">
                {report.metrics.contribution.now ?? "—"} contributions
              </span>
            ) : null}
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={reload}
            aria-label="Refresh report"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#f4f4f5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-h-0 text-[#0a0a0a] dark:text-zinc-100">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              label="Period"
              options={PERIOD_OPTIONS}
              value={period}
              onChange={setPeriod}
            />
            {period === "custom" ? (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-[#71717a] dark:text-zinc-400">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    className={FILTER_INPUT_CLASS}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[#71717a] dark:text-zinc-400">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                    className={FILTER_INPUT_CLASS}
                  />
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
              <SegmentedControl
                label="Runtime"
                options={RUNTIME_OPTIONS}
                value={runtime}
                onChange={setRuntime}
              />
              <label className="flex items-center gap-1.5 text-[11px] text-[#71717a] dark:text-zinc-400">
                Project
                <select
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                  className={FILTER_INPUT_CLASS}
                >
                  <option value="all">All projects</option>
                  {(report?.projects ?? []).map((url) => (
                    <option key={url} value={url}>
                      {parseRepoName(url)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-[#71717a] dark:text-zinc-400">
                Member
                <select
                  value={member}
                  onChange={(event) => setMember(event.target.value)}
                  className={FILTER_INPUT_CLASS}
                >
                  <option value="all">Everyone</option>
                  {(report?.members ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {state.kind === "loading" ? (
            <ReportSkeleton />
          ) : state.kind === "error" ? (
            <LoadErrorState message={state.message} onRetry={reload} />
          ) : report ? (
            <>
              <section
                aria-label="Key metrics"
                className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#e4e4e7] bg-[#e4e4e7] dark:border-zinc-800 dark:bg-zinc-800 md:grid-cols-3 lg:grid-cols-6"
              >
                {METRICS.map((metric) => (
                  <KpiCell
                    key={metric.key}
                    label={metric.label}
                    metric={report.metrics[metric.key]}
                    format={metric.format}
                  />
                ))}
              </section>

              <ContributionSection days={report.contribution} />

              <PullRequestsSection pullRequests={report.pullRequests} />
            </>
          ) : null}
        </div>
      </div>
    </MainCard>
  );
}
