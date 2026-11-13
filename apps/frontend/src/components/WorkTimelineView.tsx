import { Check, CheckSquare } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef } from "react";
import { statusLabel } from "../ui-helpers";
import { viewButtonClass } from "./ui/ViewChrome";

export interface WorkTimelineTask {
  id: string;
  title: string;
  status: string;
  /** Calendar day `YYYY-MM-DD` (a longer ISO string is cut to its date). */
  startDate?: string;
  endDate?: string;
  assigneeName?: string;
}

export interface WorkTimelineViewProps {
  tasks: WorkTimelineTask[];
  onOpen(id: string): void;
  /** Opens the approval review for rows that are waiting on approval. */
  onReview?(id: string): void;
  className?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

const DAY_W = 24;
const WEEK_W = DAY_W * 7;
const DAY_MS = 86_400_000;
const WEEKS_BEFORE = 6;
const WEEKS_AFTER = 9;
const LEAD_WEEKS = 2;
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

type Tone = "backlog" | "todo" | "progress" | "review" | "done" | "attention";

const TONES: Record<string, Tone> = {
  backlog: "backlog",
  completed: "done",
  done: "done",
  merged: "done",
  running: "progress",
  live: "progress",
  in_progress: "progress",
  "in-progress": "progress",
  "pr-open": "review",
  in_review: "review",
  "in-review": "review",
  "waiting-approval": "review",
  "needs-approval": "review",
  error: "attention",
  failed: "attention",
  aborted: "attention",
  cancelled: "attention",
  blocked: "attention",
  unknown: "attention",
  "needs-provider": "attention",
};

const CIRCLE: Record<Tone, string> = {
  backlog: "border border-dashed border-[var(--muted-foreground-3)]",
  todo: "border-[1.5px] border-[var(--muted-foreground-2)]",
  progress:
    "border-[1.5px] border-amber-500 bg-[linear-gradient(90deg,#f59e0b_50%,transparent_50%)]",
  review: "border-[1.5px] border-violet-500 inline-flex items-center justify-center",
  done: "bg-[var(--success)] text-white inline-flex items-center justify-center",
  attention: "border-[1.5px] border-[var(--destructive)]",
};

const BAR: Record<Tone, string> = {
  backlog: "bg-zinc-300 dark:bg-zinc-600",
  todo: "bg-zinc-400 dark:bg-zinc-500",
  progress: "bg-amber-500",
  review: "bg-violet-500",
  done: "bg-[var(--success)]",
  attention: "bg-[var(--destructive)]",
};

function toneOf(status: string): Tone {
  return TONES[status] ?? "todo";
}

function labelOf(status: string): string {
  return status === "pr-open" ? "PR linked" : statusLabel(status);
}

function parseDay(value?: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// Rounding absorbs the hour a DST change adds or removes between two local midnights.
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function weekStart(date: Date): Date {
  return addDays(date, -date.getDay());
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
  ).toUpperCase();
}

/** Week grid timeline: a sticky task column beside a horizontally scrolling calendar of dated bars. */
export function WorkTimelineView({
  tasks,
  onOpen,
  onReview,
  className = "",
  emptyTitle = "No tasks yet",
  emptyDescription = "Add a task above. It lands in Todo.",
}: WorkTimelineViewProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const empty = tasks.length === 0;

  const layout = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const rows = tasks.map((task) => {
      const a = parseDay(task.startDate);
      const b = parseDay(task.endDate);
      const first = a ?? b;
      const last = b ?? a;
      if (!first || !last) return { task, span: null };
      return {
        task,
        span: first <= last ? { start: first, end: last } : { start: last, end: first },
      };
    });
    let start = addDays(weekStart(today), -WEEKS_BEFORE * 7);
    let end = addDays(weekStart(today), WEEKS_AFTER * 7);
    for (const { span } of rows) {
      if (!span) continue;
      if (span.start < start) start = weekStart(span.start);
      if (span.end >= end) end = addDays(weekStart(span.end), 7);
    }
    const weeks = Array.from({ length: daysBetween(start, end) / 7 }, (_, i) =>
      addDays(start, i * 7),
    );
    return { start, weeks, todayIndex: daysBetween(start, today), rows };
  }, [tasks]);

  const { start, weeks, todayIndex, rows } = layout;
  const gridWidth = weeks.length * WEEK_W;
  const todayX = todayIndex * DAY_W;

  // Only on mount or when the range start shifts, so live task updates never yank the user's scroll.
  useEffect(() => {
    if (empty || !scrollerRef.current) return;
    scrollerRef.current.scrollLeft = (Math.floor(todayIndex / 7) - LEAD_WEEKS) * WEEK_W;
  }, [empty, todayIndex]);

  if (empty) {
    return (
      <div
        className={`flex flex-col items-center justify-center h-full min-h-[300px] p-8 text-center select-none ${className}`.trim()}
      >
        <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 mb-3">
          <CheckSquare className="w-5 h-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{emptyTitle}</p>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs">{emptyDescription}</p>
      </div>
    );
  }

  const gridLines = {
    width: gridWidth,
    backgroundImage: "linear-gradient(to right, var(--border-1) 1px, transparent 1px)",
    backgroundSize: `${WEEK_W}px 100%`,
  };

  return (
    <div
      ref={scrollerRef}
      data-testid="timeline-scroller"
      className={`relative w-full overflow-auto [--tl-left:10rem] sm:[--tl-left:16rem] ${className}`.trim()}
    >
      <div
        className="relative min-w-full"
        style={{ width: `calc(var(--tl-left) + ${gridWidth}px)` }}
      >
        <div
          aria-hidden="true"
          className="sticky top-0 z-30 flex border-b border-[var(--border-1)] bg-[var(--card)]"
        >
          <div className="sticky left-0 z-40 w-[var(--tl-left)] shrink-0 border-r border-[var(--border-1)] bg-[var(--card)]" />
          <div className="relative shrink-0 select-none" style={gridLines}>
            <div className="flex h-6">
              {weeks.map((week) => (
                <span
                  key={week.getTime()}
                  className="shrink-0 px-1.5 pt-1 text-[11px] font-medium text-[var(--muted-foreground-2)]"
                  style={{ width: WEEK_W }}
                >
                  {shortDate(week)}
                </span>
              ))}
            </div>
            <div className="flex h-5">
              {weeks.flatMap((week) =>
                WEEKDAYS.map((letter, d) => (
                  <span
                    key={addDays(week, d).getTime()}
                    className="shrink-0 text-center text-[10px] text-[var(--muted-foreground-3)]"
                    style={{ width: DAY_W }}
                  >
                    {letter}
                  </span>
                )),
              )}
            </div>
            <span
              data-testid="timeline-today"
              className="absolute top-0.5 z-10 -translate-x-1/2 rounded-full bg-[var(--destructive)] px-1.5 py-px text-[10px] font-semibold leading-4 text-white"
              style={{ left: todayX + DAY_W / 2 }}
            >
              Today
            </span>
          </div>
        </div>

        <ul aria-label="Timeline tasks" className="relative">
          {rows.map(({ task, span }) => {
            const tone = toneOf(task.status);
            const label = labelOf(task.status);
            const offset = span ? daysBetween(start, span.start) : 0;
            const length = span ? daysBetween(span.start, span.end) + 1 : 0;
            const range = span
              ? length > 1
                ? `${shortDate(span.start)} – ${shortDate(span.end)}`
                : shortDate(span.start)
              : "";
            return (
              <li
                key={task.id}
                className="flex h-11 border-b border-[var(--border-1)] last:border-b-0"
              >
                <div className="sticky left-0 z-20 flex w-[var(--tl-left)] shrink-0 items-center gap-1 border-r border-[var(--border-1)] bg-[var(--card)] pr-1.5">
                  <button
                    type="button"
                    onClick={() => onOpen(task.id)}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left hover:bg-[var(--card-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]"
                  >
                    <span
                      aria-hidden="true"
                      className={`size-3.5 shrink-0 rounded-full ${CIRCLE[tone]}`}
                    >
                      {tone === "done" ? <Check className="size-2.5" strokeWidth={3} /> : null}
                      {tone === "review" ? (
                        <span className="size-1.5 rounded-full bg-violet-500" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]">
                      {task.title || "Untitled task"}
                    </span>
                    <span className="sr-only">{label}</span>
                  </button>
                  {task.status === "waiting-approval" && onReview ? (
                    <button
                      type="button"
                      onClick={() => onReview(task.id)}
                      aria-label={`Review ${task.title}`}
                      className={`${viewButtonClass} shrink-0`}
                    >
                      Review
                    </button>
                  ) : null}
                  {task.assigneeName ? (
                    <span
                      role="img"
                      aria-label={`Assigned to ${task.assigneeName}`}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--section)] text-[10px] font-semibold text-[var(--muted-foreground-1)]"
                    >
                      {initials(task.assigneeName)}
                    </span>
                  ) : (
                    <span
                      role="img"
                      aria-label="Unassigned"
                      className="size-6 shrink-0 rounded-full border border-dashed border-[var(--muted-foreground-3)]"
                    />
                  )}
                </div>
                <div className="relative shrink-0" style={gridLines}>
                  {span ? (
                    <button
                      type="button"
                      onClick={() => onOpen(task.id)}
                      aria-label={`${task.title || "Untitled task"}, ${range}, ${label}`}
                      title={`${task.title || "Untitled task"} · ${range}`}
                      className={`absolute top-1/2 h-6 -translate-y-1/2 rounded-md opacity-90 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] motion-reduce:transition-none transition-opacity ${BAR[tone]}`}
                      style={{ left: offset * DAY_W + 2, width: length * DAY_W - 4 }}
                    />
                  ) : <span className="sticky left-[var(--tl-left)] inline-flex h-full items-center px-3 text-xs text-[var(--muted-foreground-3)]">No dates recorded</span>}
                </div>
              </li>
            );
          })}
        </ul>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--destructive)]"
          style={{ left: `calc(var(--tl-left) + ${todayX + DAY_W / 2}px)` }}
        />
      </div>
    </div>
  );
}
