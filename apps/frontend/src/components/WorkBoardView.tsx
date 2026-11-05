import type { JSX } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Circle,
  Clock,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { TaskHistoryAttempt, TaskHistoryItem, TaskHistoryStatus } from "./TaskHistory";
import type { RunStatus } from "@shiba/shared";
import { formatTimeAgo, statusLabel } from "../ui-helpers";

export type BoardTaskStatus = TaskHistoryStatus | RunStatus | string;

export interface WorkBoardTask {
  id: string;
  title: string;
  status: BoardTaskStatus;
  updatedAt?: number;
  repoName?: string;
  error?: string;
  attempts?: TaskHistoryAttempt[];
}

export type WorkBoardItem = WorkBoardTask | TaskHistoryItem;

export interface WorkBoardViewProps {
  tasks: (WorkBoardTask | TaskHistoryItem)[];
  onOpen: (id: string) => void;
  className?: string;
}

export type KanbanColumnId = "todo" | "in_progress" | "needs_approval" | "done";

export interface KanbanColumnDef {
  id: KanbanColumnId;
  title: string;
  emptyText: string;
  dotClass: string;
}

export const KANBAN_COLUMNS: readonly KanbanColumnDef[] = [
  {
    id: "todo",
    title: "Todo",
    emptyText: "No tasks in Todo",
    dotClass: "bg-zinc-400 dark:bg-zinc-500",
  },
  {
    id: "in_progress",
    title: "In progress",
    emptyText: "Nothing in progress",
    dotClass: "bg-blue-500 dark:bg-blue-400",
  },
  {
    id: "needs_approval",
    title: "Needs approval",
    emptyText: "Nothing needs approval",
    dotClass: "bg-amber-500 dark:bg-amber-400",
  },
  {
    id: "done",
    title: "Done",
    emptyText: "No completed tasks",
    dotClass: "bg-emerald-500 dark:bg-emerald-400",
  },
] as const;

export interface NormalizedBoardTask {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  repoName?: string;
  error?: string;
}

/**
 * Normalizes either a TaskHistoryItem (Shiba task history) or a WorkBoardTask
 * into a consistent shape without inventing fields.
 */
export function normalizeBoardTask(item: WorkBoardTask | TaskHistoryItem): NormalizedBoardTask {
  if ("taskId" in item && typeof item.taskId === "string") {
    const latestAttempt = item.attempts?.at(-1);
    return {
      id: item.taskId,
      title: item.title || "Untitled task",
      status: latestAttempt?.status ?? "pending",
      updatedAt: item.updatedAt ?? latestAttempt?.updatedAt ?? 0,
      error: latestAttempt?.error,
    };
  }

  const task = item as WorkBoardTask;
  const latestAttempt = task.attempts?.at(-1);
  return {
    id: task.id,
    title: task.title || "Untitled task",
    status: task.status ?? latestAttempt?.status ?? "pending",
    updatedAt: task.updatedAt ?? latestAttempt?.updatedAt ?? 0,
    repoName: task.repoName,
    error: task.error ?? latestAttempt?.error,
  };
}

/**
 * Derives the kanban column from Shiba's real task/session status type.
 */
export function deriveKanbanColumn(status: string): KanbanColumnId {
  const normalized = status.toLowerCase().trim();
  switch (normalized) {
    case "pending_approval":
    case "waiting-approval":
    case "needs-approval":
    case "needs_approval":
    case "needs-provider":
      return "needs_approval";

    case "running":
    case "live":
    case "in_progress":
    case "in-progress":
      return "in_progress";

    case "completed":
    case "done":
    case "error":
    case "aborted":
    case "cancelled":
    case "rejected":
    case "expired":
    case "unknown":
      return "done";

    case "submitting":
    case "pending":
    case "ready":
    case "todo":
    default:
      return "todo";
  }
}

function getTaskBadge(status: string) {
  const s = status.toLowerCase().trim();
  switch (s) {
    case "completed":
    case "done":
      return {
        label: "Completed",
        className:
          "text-emerald-700 bg-emerald-50 border-emerald-200/80 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800",
        icon: CheckCircle2,
        spin: false,
      };
    case "running":
    case "live":
      return {
        label: "Running",
        className:
          "text-blue-700 bg-blue-50 border-blue-200/80 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800",
        icon: LoaderCircle,
        spin: true,
      };
    case "pending_approval":
    case "waiting-approval":
      return {
        label: "Needs approval",
        className:
          "text-amber-700 bg-amber-50 border-amber-200/80 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800",
        icon: Clock,
        spin: false,
      };
    case "error":
    case "aborted":
    case "rejected":
    case "expired":
      return {
        label: statusLabel(s),
        className:
          "text-rose-700 bg-rose-50 border-rose-200/80 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-800",
        icon: AlertCircle,
        spin: false,
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className:
          "text-zinc-600 bg-zinc-100 border-zinc-200 dark:text-zinc-400 dark:bg-zinc-800 dark:border-zinc-700",
        icon: Ban,
        spin: false,
      };
    case "unknown":
      return {
        label: "Unknown",
        className:
          "text-amber-700 bg-amber-50 border-amber-200/80 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800",
        icon: TriangleAlert,
        spin: false,
      };
    case "submitting":
      return {
        label: "Submitting",
        className:
          "text-blue-700 bg-blue-50 border-blue-200/80 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800",
        icon: LoaderCircle,
        spin: true,
      };
    case "pending":
    case "ready":
    default:
      return {
        label: statusLabel(s),
        className:
          "text-zinc-600 bg-zinc-100 border-zinc-200 dark:text-zinc-400 dark:bg-zinc-800 dark:border-zinc-700",
        icon: Circle,
        spin: false,
      };
  }
}

/**
 * Kanban Board view for tasks:
 * 4 columns: Todo, In progress, Needs approval, Done.
 * Rounded-xl columns with header + count and muted empty-column text.
 */
export function WorkBoardView({
  tasks,
  onOpen,
  className = "",
}: WorkBoardViewProps): JSX.Element {
  const normalizedTasks = tasks.map(normalizeBoardTask);

  const columnMap: Record<KanbanColumnId, NormalizedBoardTask[]> = {
    todo: [],
    in_progress: [],
    needs_approval: [],
    done: [],
  };

  for (const task of normalizedTasks) {
    const col = deriveKanbanColumn(task.status);
    columnMap[col].push(task);
  }

  return (
    <section
      aria-label="Work board"
      className={`w-full flex-1 flex flex-col min-h-0 overflow-y-auto ${className}`.trim()}
    >
      <div className="p-4 w-full flex-1 min-h-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 h-full items-start">
          {KANBAN_COLUMNS.map((col) => {
            const colTasks = columnMap[col.id];
            return (
              <div
                key={col.id}
                data-testid={`kanban-column-${col.id}`}
                className="rounded-xl bg-zinc-50/80 dark:bg-zinc-900/40 border border-zinc-200/80 dark:border-zinc-800/80 p-3 flex flex-col min-h-[280px]"
              >
                {/* Column Header + count */}
                <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-zinc-200/60 dark:border-zinc-800/60 select-none">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${col.dotClass}`}
                      aria-hidden="true"
                    />
                    <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      {col.title}
                    </h3>
                  </div>
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 tabular-nums"
                    aria-label={`${colTasks.length} tasks`}
                  >
                    {colTasks.length}
                  </span>
                </div>

                {/* Card rows or empty text */}
                {colTasks.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center py-10 px-3 text-center select-none">
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                      {col.emptyText}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {colTasks.map((task) => {
                      const badge = getTaskBadge(task.status);
                      const BadgeIcon = badge.icon;
                      return (
                        <div
                          key={task.id}
                          role="button"
                          tabIndex={0}
                          data-testid={`board-card-${task.id}`}
                          onClick={() => onOpen(task.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpen(task.id);
                            }
                          }}
                          className="group rounded-lg bg-white dark:bg-zinc-950 p-3 border border-zinc-200/80 dark:border-zinc-800 shadow-sm hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow transition-all cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 select-none"
                        >
                          <p className="text-xs sm:text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                            {task.title}
                          </p>

                          {task.error ? (
                            <p className="text-[11px] text-rose-500 dark:text-rose-400 line-clamp-1 mt-1">
                              {task.error}
                            </p>
                          ) : null}

                          <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${badge.className}`}
                            >
                              <BadgeIcon
                                className={`size-3 shrink-0 ${badge.spin ? "animate-spin" : ""}`}
                                aria-hidden="true"
                              />
                              <span>{badge.label}</span>
                            </span>

                            <div className="flex items-center gap-1.5 truncate">
                              {task.repoName ? (
                                <span className="truncate max-w-[90px] text-zinc-500 dark:text-zinc-400">
                                  {task.repoName}
                                </span>
                              ) : null}
                              {task.updatedAt > 0 ? (
                                <span>{formatTimeAgo(task.updatedAt)}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default WorkBoardView;
