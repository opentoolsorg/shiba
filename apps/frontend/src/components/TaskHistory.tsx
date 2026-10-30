import { RotateCcw, Square, TriangleAlert } from "lucide-react";

export type TaskHistoryStatus =
  | "submitting" | "pending_approval" | "running" | "completed"
  | "error" | "aborted" | "cancelled" | "unknown" | "rejected" | "expired";

export interface TaskHistoryAttempt {
  attempt: number;
  runId?: string;
  approvalId?: string;
  status: TaskHistoryStatus;
  updatedAt: number;
  error?: string;
}

export interface TaskHistoryItem {
  taskId: string;
  title: string;
  updatedAt: number;
  attempts: TaskHistoryAttempt[];
}

export function isTaskHistoryRetryable(attempt: TaskHistoryAttempt): boolean {
  return ["error", "aborted", "cancelled", "rejected", "expired"].includes(attempt.status);
}

export function TaskHistory({
  tasks,
  loading = false,
  error,
  onRetry,
  onCancel,
  onSelectRun,
}: {
  tasks: TaskHistoryItem[];
  loading?: boolean;
  error?: string | null;
  onRetry?: (taskId: string) => void;
  onCancel?: (taskId: string, attempt: number) => void;
  onSelectRun?: (runId: string) => void;
}) {
  return (
    <section aria-label="Task attempt history" className="rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--fg)]">Task history</h2>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">Retries stay linked to the same task and approval input.</p>
        </div>
        <span className="text-xs tabular-nums text-[var(--muted-foreground-2)]">{tasks.length} tasks</span>
      </div>
      {error ? <p role="alert" className="mb-3 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive-soft)] px-3 py-2 text-sm text-[var(--destructive)]">{error}</p> : null}
      {loading ? <p className="py-3 text-sm text-[var(--muted-foreground-2)]">Loading task history…</p> : null}
      {!loading && tasks.length === 0 ? <p className="py-3 text-sm text-[var(--muted-foreground-2)]">No task attempts yet.</p> : null}
      <ul className="space-y-2">
        {tasks.map((task) => {
          const latest = task.attempts.at(-1);
          if (!latest) return null;
          const latestRunId = latest.runId;
          const active = latest.status === "running" || latest.status === "pending_approval" || latest.status === "submitting";
          const retryable = isTaskHistoryRetryable(latest);
          return (
            <li key={task.taskId} data-testid={`task-history-${task.taskId}`} className="rounded-md border border-[var(--border-1)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--fg)]">{task.title || "Untitled task"}</p>
                  <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{task.attempts.length} {task.attempts.length === 1 ? "attempt" : "attempts"} · latest {latest.status.replaceAll("_", " ")}</p>
                  {latest.status === "unknown" ? <p className="mt-1 flex items-center gap-1 text-xs text-[var(--attention)]"><TriangleAlert size={13} aria-hidden="true" /> Outcome uncertain; inspect before retrying.</p> : null}
                  {latest.error ? <p className="mt-1 line-clamp-2 text-xs text-[var(--destructive)]">{latest.error}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {latestRunId && onSelectRun ? <button type="button" onClick={() => onSelectRun(latestRunId)} className="rounded px-2 py-1 text-xs text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]">Open</button> : null}
                  {active && onCancel ? <button type="button" onClick={() => onCancel(task.taskId, latest.attempt)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive-soft)]"><Square size={12} aria-hidden="true" /> Cancel</button> : null}
                  {retryable && onRetry ? <button type="button" onClick={() => onRetry(task.taskId)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--primary)] hover:bg-[var(--secondary)]"><RotateCcw size={12} aria-hidden="true" /> Retry</button> : null}
                </div>
              </div>
              {task.attempts.length > 1 ? <ol aria-label="Attempts" className="mt-2 space-y-1 border-l border-[var(--border-1)] pl-3">
                {task.attempts.map((attempt) => <li key={`${task.taskId}:${attempt.attempt}`} className="flex items-center justify-between gap-3 text-[11px] text-[var(--muted-foreground-2)]"><span>Attempt {attempt.attempt}</span><span>{attempt.status.replaceAll("_", " ")}{attempt.runId ? ` · ${attempt.runId}` : attempt.approvalId ? ` · approval ${attempt.approvalId}` : ""}</span></li>)}
              </ol> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
