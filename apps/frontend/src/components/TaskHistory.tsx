import React from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Circle,
  Clock,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  Square,
  TriangleAlert,
} from "lucide-react";

export type TaskHistoryStatus =
  | "submitting"
  | "pending_approval"
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "cancelled"
  | "unknown"
  | "rejected"
  | "expired";

export interface TaskHistoryAttempt {
  attempt: number;
  runId?: string;
  approvalId?: string;
  status: TaskHistoryStatus;
  updatedAt: number;
  error?: string;
  retryable?: boolean;
}

export interface TaskHistoryItem {
  taskId: string;
  title: string;
  updatedAt: number;
  attempts: TaskHistoryAttempt[];
}

export interface TaskHistoryProps {
  tasks: TaskHistoryItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: (taskId: string) => void;
  onCancel?: (taskId: string, attempt: number) => void;
  onSelectRun?: (runId: string) => void;
  className?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  "aria-label"?: string;
}

export function isTaskHistoryRetryable(attempt: TaskHistoryAttempt): boolean {
  return (
    attempt.retryable !== false &&
    ["error", "aborted", "cancelled", "rejected", "expired"].includes(attempt.status)
  );
}

function TaskStatusIcon({ status }: { status: TaskHistoryStatus }) {
  switch (status) {
    case "completed":
      return (
        <CheckCircle2
          className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500"
          aria-label="Completed"
        />
      );
    case "running":
    case "submitting":
      return (
        <LoaderCircle
          className="h-4 w-4 shrink-0 animate-spin text-blue-500 dark:text-blue-400"
          aria-label="Running"
        />
      );
    case "pending":
    case "pending_approval":
      return (
        <Clock
          className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400"
          aria-label="Pending"
        />
      );
    case "error":
    case "aborted":
    case "rejected":
    case "expired":
      return (
        <AlertCircle
          className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400"
          aria-label="Error"
        />
      );
    case "cancelled":
      return (
        <Ban
          className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500"
          aria-label="Cancelled"
        />
      );
    case "unknown":
      return (
        <TriangleAlert
          className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400"
          aria-label="Unknown"
        />
      );
    default:
      return (
        <Circle
          className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500"
          aria-label="Todo"
        />
      );
  }
}

export function TaskHistory({
  tasks,
  loading = false,
  error,
  onRetry,
  onCancel,
  onSelectRun,
  className = "",
  emptyTitle = "No task attempts yet.",
  emptyDescription,
  "aria-label": ariaLabel = "Task list",
}: TaskHistoryProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={`flex w-full flex-1 flex-col ${className}`.trim()}
    >
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-[var(--destructive-fg)] dark:border-rose-900/50 dark:bg-rose-950/20"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center p-8 text-center select-none">
          <LoaderCircle
            className="mb-2 h-6 w-6 animate-spin text-zinc-400 dark:text-zinc-500"
            aria-hidden="true"
          />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading tasks…</p>
        </div>
      ) : null}

      {!loading && tasks.length === 0 ? (
        <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center p-8 text-center select-none">
          <ListChecks
            className="mb-2 h-8 w-8 stroke-[1.5] text-zinc-400 dark:text-zinc-500"
            aria-hidden="true"
          />
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            {emptyTitle}
          </h3>
          {emptyDescription ? (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {emptyDescription}
            </p>
          ) : null}
        </div>
      ) : null}

      {!loading && tasks.length > 0 ? (
        <ul className="flex w-full flex-col gap-0.5">
          {tasks.map((task) => {
            const latest = task.attempts.at(-1);
            if (!latest) return null;
            const latestRunId = latest.runId;
            const active =
              latest.status === "pending" ||
              latest.status === "running" ||
              latest.status === "pending_approval" ||
              latest.status === "submitting";
            const retryable = isTaskHistoryRetryable(latest);

            return (
              <li
                key={task.taskId}
                data-testid={`task-history-${task.taskId}`}
                className="group flex flex-col rounded-lg transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
              >
                <div className="flex h-9 min-h-[36px] items-center justify-between gap-3 px-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <TaskStatusIcon status={latest.status} />
                    <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {task.title || "Untitled task"}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
                      {task.attempts.length}{" "}
                      {task.attempts.length === 1 ? "attempt" : "attempts"} · latest{" "}
                      {latest.status.replaceAll("_", " ")}
                    </span>

                    {latestRunId && onSelectRun ? (
                      <button
                        type="button"
                        onClick={() => onSelectRun(latestRunId)}
                        className="rounded px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-700"
                      >
                        Open
                      </button>
                    ) : null}

                    {active && onCancel ? (
                      <button
                        type="button"
                        onClick={() => onCancel(task.taskId, latest.attempt)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-[var(--destructive-fg)] hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      >
                        <Square size={12} aria-hidden="true" /> Cancel
                      </button>
                    ) : null}

                    {retryable && onRetry ? (
                      <button
                        type="button"
                        onClick={() => onRetry(task.taskId)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
                      >
                        <RotateCcw size={12} aria-hidden="true" /> Retry
                      </button>
                    ) : null}
                  </div>
                </div>

                {latest.status === "unknown" ? (
                  <p className="flex items-center gap-1 px-2.5 pb-2 pt-0.5 text-xs text-[var(--warning-fg)]">
                    <TriangleAlert size={12} aria-hidden="true" /> Outcome uncertain;
                    inspect before retrying.
                  </p>
                ) : null}

                {latest.error ? (
                  <p className="line-clamp-2 px-2.5 pb-2 pt-0.5 text-xs text-[var(--destructive-fg)]">
                    {latest.error}
                  </p>
                ) : null}

                {task.attempts.length > 1 ? (
                  <ol
                    aria-label="Attempts"
                    className="mx-2.5 mb-2 space-y-1 border-l border-zinc-200 pl-3 dark:border-zinc-800"
                  >
                    {task.attempts.map((attempt) => (
                      <li
                        key={`${task.taskId}:${attempt.attempt}`}
                        className="flex items-center justify-between gap-3 text-[11px] text-zinc-400 dark:text-zinc-500"
                      >
                        <span>Attempt {attempt.attempt}</span>
                        <span>
                          {attempt.status.replaceAll("_", " ")}
                          {attempt.runId
                            ? ` · ${attempt.runId}`
                            : attempt.approvalId
                              ? ` · approval ${attempt.approvalId}`
                              : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

