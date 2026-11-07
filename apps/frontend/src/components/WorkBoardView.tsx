import type { RunStatus } from "@shiba/shared";
import { type DragEvent, type JSX, useState } from "react";
import { avatarStatusFromTask } from "../agent-mascots";
import { AgentAvatar } from "./AgentAvatar";
import type { TaskDetailAgent } from "./TaskDetailPanel";
import type { TaskHistoryAttempt, TaskHistoryItem, TaskHistoryStatus } from "./TaskHistory";
import { viewButtonClass } from "./ui/ViewChrome";
import {
  WORK_LIST_GROUPS,
  type WorkListGroup,
  WorkStatusIcon,
  workListGroup,
} from "./WorkListView";

export type BoardTaskStatus = TaskHistoryStatus | RunStatus | string;

export interface WorkBoardTask {
  id: string;
  title: string;
  status: BoardTaskStatus;
  updatedAt?: number;
  repoName?: string;
  error?: string;
  attempts?: TaskHistoryAttempt[];
  assigneeActorId?: string;
  assigneeUserId?: string;
  assigneeName?: string;
  assigneeKind?: "human" | "agent";
}

export interface WorkBoardViewProps {
  tasks: (WorkBoardTask | TaskHistoryItem)[];
  agents?: readonly TaskDetailAgent[];
  onOpen: (id: string) => void;
  /** Moves a task to another column; drag-and-drop and the status menu are disabled without it. */
  onMove?: (id: string, status: BoardWireStatus) => void;
  /** Opens the approval review for a needs-approval card. */
  onReview?: (id: string) => void;
  className?: string;
}

export type KanbanColumnId =
  | "todo"
  | "in_progress"
  | "needs_approval"
  | "attention"
  | "pr_open"
  | "done";

/** Run-oriented grouping kept for WorkView's status normalisation. */
export function deriveKanbanColumn(status: string): KanbanColumnId {
  switch (status.toLowerCase().trim()) {
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
    case "pr-open":
    case "pr_open":
      return "pr_open";
    case "error":
    case "aborted":
    case "cancelled":
    case "rejected":
    case "expired":
    case "unknown":
      return "attention";
    case "completed":
    case "done":
      return "done";
    default:
      return "todo";
  }
}

/** Maps any task/run status onto the five board columns, matching the List view's groups. */
/** Hyphenated status as stored on TeamWorkItem; column ids stay underscored internally. */
export type BoardWireStatus = "backlog" | "todo" | "in-progress" | "in-review" | "done";

export function toWireStatus(column: WorkListGroup): BoardWireStatus {
  return column.replace("_", "-") as BoardWireStatus;
}

export function boardColumn(status: string): WorkListGroup {
  switch (status.toLowerCase().replace(/[\s-]/g, "_")) {
    case "live":
      return "in_progress";
    case "pr_open":
    case "pending_approval":
    case "waiting_approval":
    case "needs_provider":
      return "in_review";
    default:
      return workListGroup(status);
  }
}

export interface NormalizedBoardTask {
  id: string;
  title: string;
  status: string;
  error?: string;
  assigneeId?: string;
  assigneeName?: string;
  assigneeKind?: "human" | "agent";
}

/** Normalizes a TaskHistoryItem or WorkBoardTask into one shape without inventing fields. */
export function normalizeBoardTask(item: WorkBoardTask | TaskHistoryItem): NormalizedBoardTask {
  if ("taskId" in item && typeof item.taskId === "string") {
    const latestAttempt = item.attempts?.at(-1);
    return {
      id: item.taskId,
      title: item.title || "Untitled task",
      status: latestAttempt?.status ?? "pending",
      error: latestAttempt?.error,
    };
  }
  const task = item as WorkBoardTask;
  const latestAttempt = task.attempts?.at(-1);
  return {
    id: task.id,
    title: task.title || "Untitled task",
    status: task.status ?? latestAttempt?.status ?? "pending",
    error: task.error ?? latestAttempt?.error,
    assigneeId: task.assigneeActorId ?? task.assigneeUserId,
    assigneeName: task.assigneeName,
    assigneeKind: task.assigneeKind,
  };
}

function AssigneeSlot({ task, agents }: { task: NormalizedBoardTask; agents: readonly TaskDetailAgent[] }): JSX.Element {
  const name = task.assigneeName ?? task.assigneeId;
  if (!task.assigneeId || !name) {
    return (
      <span
        role="img"
        aria-label="Unassigned"
        className="size-5 shrink-0 rounded-full border border-dashed border-zinc-300 dark:border-zinc-600"
      />
    );
  }
  const agent = agents.find((item) => item.id === task.assigneeId);
  if (task.assigneeKind === "agent")
    return <AgentAvatar id={task.assigneeId} name={name} mascotPreset={agent?.mascotPreset} look={agent?.look} role={agent?.role} status={avatarStatusFromTask(task.status)} size={20} />;
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** Kanban board: Backlog, Todo, In progress, In review, Done, with drag-and-drop and a per-card status menu. */
export function WorkBoardView({
  tasks,
  agents = [],
  onOpen,
  onMove,
  onReview,
  className = "",
}: WorkBoardViewProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<WorkListGroup | null>(null);
  const normalized = tasks.map(normalizeBoardTask);

  const move = (id: string, to: WorkListGroup) => {
    const task = normalized.find((t) => t.id === id);
    if (task && boardColumn(task.status) !== to) onMove?.(id, toWireStatus(to));
  };

  const dropProps = (column: WorkListGroup) =>
    onMove
      ? {
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setOverColumn(column);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverColumn(null);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            const id = e.dataTransfer?.getData("text/plain") || draggingId;
            setOverColumn(null);
            setDraggingId(null);
            if (id) move(id, column);
          },
        }
      : {};

  return (
    <section
      aria-label="Work board"
      className={`flex min-h-0 w-full flex-1 flex-col ${className}`.trim()}
    >
      <div className="flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto p-4">
        {WORK_LIST_GROUPS.map((col) => {
          const colTasks = normalized.filter((t) => boardColumn(t.status) === col.id);
          const isOver = overColumn === col.id;
          return (
            <section
              key={col.id}
              aria-label={col.label}
              data-testid={`board-column-${col.id}`}
              className={`flex w-[min(17rem,calc(100vw-3rem))] shrink-0 snap-start flex-col rounded-xl p-2 motion-safe:transition-colors ${isOver ? "bg-zinc-100 dark:bg-zinc-800/60" : "bg-zinc-50/80 dark:bg-zinc-900/40"}`}
              {...dropProps(col.id)}
            >
              <h3 className="flex items-center gap-2 px-1.5 pb-2 pt-1 text-xs font-semibold text-zinc-900 select-none dark:text-zinc-100">
                <WorkStatusIcon group={col.id} />
                {col.label}
                <span className="font-normal tabular-nums text-zinc-500 dark:text-zinc-400">
                  {colTasks.length}
                </span>
              </h3>

              {colTasks.length === 0 ? (
                <div
                  className={`flex min-h-24 items-center justify-center rounded-lg border border-dashed text-xs select-none ${isOver ? "border-zinc-400 text-zinc-600 dark:border-zinc-500 dark:text-zinc-300" : "border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500"}`}
                >
                  Nothing here
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {colTasks.map((task) => (
                    <li key={task.id} className="flex flex-col gap-1.5">
                      <article
                        data-testid={`board-card-${task.id}`}
                        draggable={Boolean(onMove)}
                        onDragStart={(e) => {
                          e.dataTransfer?.setData("text/plain", task.id);
                          setDraggingId(task.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setOverColumn(null);
                        }}
                        className={`relative rounded-lg border border-zinc-200/80 bg-white p-3 shadow-sm hover:border-zinc-300 focus-within:ring-2 focus-within:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700 motion-safe:transition-colors ${onMove ? "cursor-grab active:cursor-grabbing" : ""} ${draggingId === task.id ? "opacity-50" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => onOpen(task.id)}
                          className="block w-full text-left text-sm font-medium leading-snug text-zinc-900 outline-none line-clamp-3 before:absolute before:inset-0 before:rounded-lg dark:text-zinc-100"
                        >
                          {task.title}
                        </button>
                        {task.error ? (
                          <p className="mt-1 line-clamp-1 text-[11px] text-[var(--destructive-fg)]">
                            {task.error}
                          </p>
                        ) : null}
                        <div className="mt-3 flex items-center justify-between gap-2">
                          {onMove ? (
                            <label className="relative z-10 inline-flex cursor-pointer rounded-full focus-within:ring-2 focus-within:ring-zinc-400">
                              <WorkStatusIcon group={boardColumn(task.status)} />
                              <select
                                aria-label={`Status of ${task.title}`}
                                value={boardColumn(task.status)}
                                onChange={(e) => move(task.id, e.target.value as WorkListGroup)}
                                className="absolute inset-0 cursor-pointer opacity-0"
                              >
                                {WORK_LIST_GROUPS.map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {g.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <WorkStatusIcon group={boardColumn(task.status)} />
                          )}
                          <span className="relative z-10">
                            <AssigneeSlot task={task} agents={agents} />
                          </span>
                        </div>
                      </article>
                      {deriveKanbanColumn(task.status) === "needs_approval" &&
                      task.status !== "needs-provider" &&
                      onReview ? (
                        <button
                          type="button"
                          onClick={() => onReview(task.id)}
                          aria-label={`Review ${task.title}`}
                          className={`${viewButtonClass} w-fit`}
                        >
                          Review
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
