import type { JSX } from "react";
import { useMemo } from "react";
import { CheckSquare } from "lucide-react";
import { statusChipClass, statusLabel } from "../ui-helpers";
import { viewButtonClass } from "./ui/ViewChrome";

export interface WorkTimelineTask {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  createdAt?: number;
  repoName?: string;
  live?: boolean;
  webSession?: boolean;
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

interface DayGroup {
  dayKey: string;
  dayLabel: string;
  tasks: WorkTimelineTask[];
}

function getTaskTimestamp(task: WorkTimelineTask): number {
  if (typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt) && task.updatedAt > 0) {
    return task.updatedAt;
  }
  if (typeof task.createdAt === "number" && Number.isFinite(task.createdAt) && task.createdAt > 0) {
    return task.createdAt;
  }
  return 0;
}

/** Formats day header label: Today, Yesterday, or e.g. "Mon, Oct 24, 2026". */
export function formatDayLabel(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return "Earlier";
  const date = new Date(timestamp);
  const now = new Date();

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return "Yesterday";

  const isSameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(isSameYear ? {} : { year: "numeric" }),
  });
}

function getDayKey(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return "earlier";
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatRowTime(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return "—";
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Presentational Timeline view:
 * Simple date-ordered, day-grouped list (day label muted 12px, rows with time + title + status),
 * newest first, from real Shiba tasks/sessions.
 */
export function WorkTimelineView({
  tasks,
  onOpen,
  onReview,
  className = "",
  emptyTitle = "No tasks yet",
  emptyDescription = "Add a task above to start a thread.",
}: WorkTimelineViewProps): JSX.Element {
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => getTaskTimestamp(b) - getTaskTimestamp(a));
  }, [tasks]);

  const dayGroups = useMemo(() => {
    const groups: DayGroup[] = [];
    const map = new Map<string, DayGroup>();

    for (const task of sortedTasks) {
      const ts = getTaskTimestamp(task);
      const key = getDayKey(ts);
      let group = map.get(key);
      if (!group) {
        group = {
          dayKey: key,
          dayLabel: formatDayLabel(ts),
          tasks: [],
        };
        map.set(key, group);
        groups.push(group);
      }
      group.tasks.push(task);
    }

    return groups;
  }, [sortedTasks]);

  if (tasks.length === 0) {
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

  return (
    <div className={`w-full flex flex-col gap-6 py-2 px-1 ${className}`.trim()}>
      {dayGroups.map((group) => (
        <section key={group.dayKey} aria-label={`Tasks for ${group.dayLabel}`} className="flex flex-col">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 px-3 py-1 select-none">
            {group.dayLabel}
          </div>

          <div className="flex flex-col mt-1 divide-y divide-zinc-100/60 dark:divide-zinc-800/40">
            {group.tasks.map((task) => {
              const ts = getTaskTimestamp(task);
              const formattedTime = formatRowTime(ts);
              const chipClass = statusChipClass(task.status);
              const label = statusLabel(task.status);

              return (
                <div key={task.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(task.id)}
                  className="min-w-0 flex-1 text-left px-3 py-2.5 min-h-11 flex items-center gap-3 rounded-lg hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
                >
                  <span className="w-16 shrink-0 font-mono text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">
                    {formattedTime}
                  </span>

                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1 min-w-0">
                    {task.title || "Untitled task"}
                  </span>

                  {task.repoName ? (
                    <span className="hidden sm:inline-block shrink-0 text-[11px] font-mono text-zinc-400 dark:text-zinc-500 truncate max-w-[140px]">
                      {task.repoName}
                    </span>
                  ) : null}

                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border shrink-0 ${chipClass}`}
                  >
                    {label}
                  </span>
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
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
