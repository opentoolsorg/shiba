/**
 * Workspace activity report — KPI strip, a 52-week contribution heatmap, and
 * the agent's pull-request output over GET /api/activity. Filters rebuild the
 * query string; null metrics render as "—" rather than fabricated zeros.
 */
import { useMemo, useState, type JSX } from "react";
import { bucketContributionWeeks, contributionLevel } from "../activity-heatmap";
import {
  type ActivityMetricWire,
  type ActivityReportQuery,
  type ActivityReportWire,
  useActivityReport,
} from "../live-status";
import { parseRepoName } from "../ui-helpers";
import { LoadErrorState } from "./LoadErrorState";

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

/** Level 0 is the neutral "no runs" cell; levels 1–4 ramp the primary color. */
const LEVEL_CLASSES = [
  "bg-[var(--secondary)]",
  "bg-[color-mix(in_oklch,var(--primary)_25%,transparent)]",
  "bg-[color-mix(in_oklch,var(--primary)_45%,transparent)]",
  "bg-[color-mix(in_oklch,var(--primary)_65%,transparent)]",
  "bg-[var(--primary)]",
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
  "bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1.5 text-xs text-[var(--fg)] focus:border-[var(--primary)] focus:outline-none";

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
      className="flex items-center gap-1 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] p-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={
            "rounded-[var(--radius-button)] px-3 py-1 text-[11px] font-medium transition-all touch:min-h-11 " +
            (value === option.value
              ? "bg-[var(--card)] font-semibold text-[var(--fg)] shadow-[var(--sh-card)]"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]")
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
      <span className="w-6 text-[9px] uppercase tracking-wide text-[var(--muted-foreground-2)]">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--secondary)]">
        <div
          className={
            active
              ? "h-full bg-[var(--primary)]"
              : "h-full bg-[color-mix(in_oklch,var(--primary)_45%,transparent)]"
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
    <div className="bg-[var(--card)] p-4">
      <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        {label}
      </p>
      <p className="mt-1.5 font-sans text-xl text-[var(--fg)]">
        {metric.now === null ? "—" : format(metric.now)}
      </p>
      {max <= 0 ? (
        <div className="my-2 border-t border-dashed border-[var(--border-1)]" />
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          <CompareBar label="Now" fraction={now / max} active />
          <CompareBar label="Last" fraction={last / max} />
        </div>
      )}
      <p className="mt-2 text-[11px] text-[var(--muted-foreground-2)]">
        {metric.last === null ? "No last period" : `${format(metric.last)} vs last period`}
      </p>
    </div>
  );
}

const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ContributionSection({ days }: { days: { date: string; count: number }[] }): JSX.Element {
  const grid = useMemo(() => bucketContributionWeeks(days, WEEKS), [days]);
  const max = useMemo(() => Math.max(0, ...days.map((day) => day.count)), [days]);
  // Sum the cells the grid shows; it can drop up to 6 of the oldest days.
  const total = useMemo(
    () => grid.columns.reduce((sum, column) => sum + column.days.reduce((s, day) => s + (day?.count ?? 0), 0), 0),
    [grid],
  );

  return (
    <section className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
      <header className="border-b border-[var(--border-1)] px-4 py-2.5">
        <h3 className="text-xs font-semibold text-[var(--fg)]">Contribution</h3>
      </header>
      <div className="overflow-x-auto px-4 py-4">
        <div className="w-max">
          <div className="mb-1 flex" style={{ gap: GAP_PX, paddingLeft: ROW_LABEL_PX + GAP_PX }}>
            {grid.columns.map((column) => (
              <div
                key={column.key}
                className="shrink-0 overflow-visible whitespace-nowrap text-[9px] leading-none text-[var(--muted-foreground-2)]"
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
                  className="text-[9px] leading-none text-[var(--muted-foreground-2)]"
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
                        ? "bg-[var(--secondary)]/50"
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
      <footer className="flex items-center justify-between gap-3 border-t border-[var(--border-1)] px-4 py-2.5 text-[11px] text-[var(--muted-foreground-2)]">
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
              (day.count > 0 ? "bg-[var(--primary)]" : "bg-[var(--secondary)]")
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
        <div key={row.member} className="flex items-center gap-3">
          <span
            className="w-36 shrink-0 truncate font-mono text-[11px] text-[var(--fg)]"
            title={row.member}
          >
            {row.member}
          </span>
          <div className="h-2.5 flex-1 bg-[var(--secondary)]">
            <div
              className="h-full bg-[var(--primary)]"
              style={{ width: `${Math.round((row.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[var(--muted-foreground-2)]">
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
    <section className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2.5">
        <h3 className="text-xs font-semibold text-[var(--fg)]">
          Pull requests opened by the agent
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
        <div className="px-4 py-10 text-center text-xs text-[var(--muted-foreground-2)]">
          No pull requests in selected period
        </div>
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
          <div key={key} className="h-24 rounded-[var(--radius-button)] bg-[var(--secondary)]" />
        ))}
      </div>
      <div className="h-44 rounded-[var(--radius-button)] bg-[var(--secondary)]" />
      <div className="h-48 rounded-[var(--radius-button)] bg-[var(--secondary)]" />
    </div>
  );
}

export function ActivityReportView({
  sessionId,
  sessionApiAvailable,
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const [period, setPeriod] = useState<Period>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [runtime, setRuntime] = useState<RuntimeFilter>("all");
  const [project, setProject] = useState("all");
  const [member, setMember] = useState("all");

  const query = useMemo<ActivityReportQuery>(() => {
    // UTC midnights so the window matches the backend's UTC day buckets; the end day is inclusive.
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
      // A cleared custom range falls back to the default window.
      days: period === "custom" ? 30 : Number(period),
      ...(project !== "all" ? { project } : {}),
      ...(member !== "all" ? { member } : {}),
    };
  }, [period, customFrom, customTo, runtime, project, member]);

  const { state, reload } = useActivityReport(sessionId, sessionApiAvailable, query);
  const report = state.kind === "data" ? state.data : null;

  return (
    <div className="bg-[var(--bg)] text-[var(--fg)]">
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-4 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-base font-semibold text-[var(--fg)]">Activity</h2>
          <p className="text-xs text-[var(--muted-foreground-2)]">
            What your agent got done for this workspace
          </p>
        </div>
      </div>

      <div className="p-4 lg:p-8">
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
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground-2)]">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    className={FILTER_INPUT_CLASS}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground-2)]">
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
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground-2)]">
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
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground-2)]">
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
                className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--border-1)] shadow-[var(--sh-card)] md:grid-cols-3 lg:grid-cols-6"
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
    </div>
  );
}
