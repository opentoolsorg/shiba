import { ChevronRight, ListChecks } from "lucide-react";
import { type JSX, type KeyboardEvent, useState } from "react";
import type { TeamWorkItem } from "../team-work-items";
import { avatarStatusFromTask } from "../agent-mascots";
import { AgentAvatar } from "./AgentAvatar";
import type { TaskDetailAgent } from "./TaskDetailPanel";

export type WorkListGroup = "backlog" | "todo" | "in_progress" | "in_review" | "done";

export const WORK_LIST_GROUPS: readonly { id: WorkListGroup; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "done", label: "Done" },
];

/** Maps the server's run-oriented status onto the five planning groups. */
export function workListGroup(status: string): WorkListGroup {
  switch (status.toLowerCase().replace(/[\s-]/g, "_")) {
    case "backlog":
    case "unknown":
      return "backlog";
    case "running":
    case "in_progress":
    case "blocked":
      return "in_progress";
    case "needs_approval":
    case "in_review":
      return "in_review";
    case "completed":
    case "done":
    case "cancelled":
      return "done";
    default:
      return "todo";
  }
}

export function WorkStatusIcon({
  group,
  className = "size-4",
}: {
  group: WorkListGroup;
  className?: string;
}): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 ${className}`}>
      {group === "backlog" ? (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray="2.4 2"
          className="stroke-zinc-400 dark:stroke-zinc-500"
        />
      ) : group === "todo" ? (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="1.5"
          className="stroke-zinc-400 dark:stroke-zinc-500"
        />
      ) : group === "in_progress" ? (
        <g className="stroke-orange-500 fill-orange-500">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
          <path d="M8 4a4 4 0 0 1 0 8z" stroke="none" />
        </g>
      ) : group === "in_review" ? (
        <g className="stroke-violet-500 fill-violet-500">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2.5" stroke="none" />
        </g>
      ) : (
        <g>
          <circle cx="8" cy="8" r="7" className="fill-emerald-500" />
          <path
            d="M5 8.2l2 2 4-4.2"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-white"
          />
        </g>
      )}
    </svg>
  );
}

function AssigneeSlot({ task, agents }: { task: TeamWorkItem; agents: readonly TaskDetailAgent[] }): JSX.Element {
  const id = task.assigneeActorId ?? task.assigneeUserId ?? task.ownerId;
  const name = task.assigneeName ?? id;
  if (!id || !name) {
    return (
      <span
        role="img"
        aria-label="Unassigned"
        className="size-5 shrink-0 rounded-full border border-dashed border-zinc-300 dark:border-zinc-600"
      />
    );
  }
  const agent = agents.find((item) => item.id === id);
  return <AgentAvatar id={id} name={name} mascotPreset={agent?.mascotPreset} look={agent?.look} role={agent?.role} status={avatarStatusFromTask(task.status)} size={20} />;
}

export interface WorkListViewProps {
  tasks: TeamWorkItem[];
  agents?: readonly TaskDetailAgent[];
  selectedId?: string;
  onOpen: (id: string) => void;
  onToggleDone: (id: string) => void;
}

export function WorkListView({
  tasks,
  agents = [],
  selectedId,
  onOpen,
  onToggleDone,
}: WorkListViewProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<WorkListGroup>>(new Set());
  const visible = tasks.filter((task) => !task.archived);

  if (visible.length === 0) {
    return (
      <section
        aria-label="Task list"
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center"
      >
        <ListChecks className="size-8 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">No tasks yet</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Add a task above. It lands in Todo.
        </p>
      </section>
    );
  }

  const toggleGroup = (id: WorkListGroup) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-work-row]"));
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    rows[
      Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))
    ]?.focus();
  };

  return (
    <section
      aria-label="Task list"
      className="flex flex-1 flex-col overflow-y-auto py-2"
      onKeyDown={moveFocus}
    >
      {WORK_LIST_GROUPS.map((group) => {
        const rows = visible.filter((task) => workListGroup(task.status) === group.id);
        if (rows.length === 0) return null;
        const open = !collapsed.has(group.id);
        const listId = `work-list-group-${group.id}`;
        return (
          <div key={group.id} className="mb-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(group.id)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
            >
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 text-zinc-400 motion-safe:transition-transform ${open ? "rotate-90" : ""}`}
              />
              <WorkStatusIcon group={group.id} className="size-3.5" />
              <span>{group.label}</span>
              <span className="tabular-nums text-zinc-400 dark:text-zinc-500">{rows.length}</span>
            </button>
            {open ? (
              <ul id={listId} aria-label={group.label}>
                {rows.map((task) => {
                  const selected = task.id === selectedId;
                  const done = group.id === "done";
                  return (
                    <li
                      key={task.id}
                      className={`flex items-center gap-2 px-4 ${selected ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"}`}
                    >
                      <button
                        type="button"
                        aria-label={
                          done ? `Mark ${task.title} not done` : `Mark ${task.title} done`
                        }
                        aria-pressed={done}
                        onClick={() => onToggleDone(task.id)}
                        className="rounded-full p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                      >
                        <WorkStatusIcon group={group.id} />
                      </button>
                      <button
                        type="button"
                        data-work-row
                        aria-current={selected ? "true" : undefined}
                        onClick={() => onOpen(task.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${done ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-900 dark:text-zinc-100"}`}
                        >
                          {task.title || "Untitled task"}
                        </span>
                        <AssigneeSlot task={task} agents={agents} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
