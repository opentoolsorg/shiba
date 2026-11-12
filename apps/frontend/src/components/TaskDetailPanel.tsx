import {
  Archive,
  CalendarDays,
  ChartNoAxesColumn,
  CircleDashed,
  CornerLeftUp,
  OctagonAlert,
  UserCheck,
  UserRound,
  X,
} from "lucide-react";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import type { TeamWorkItem, TeamWorkPriority } from "../team-work-items";
import type { WorkTaskPatch } from "../work-mutations";
import { AgentAvatar } from "./AgentAvatar";
import { TaskActivity } from "./TaskActivity";
import { TaskDetailSections } from "./TaskDetailSections";

export interface TaskDetailAgent {
  id: string;
  name: string;
  role?: EmployeeRole;
  mascotPreset?: CustomAgentMascotPreset;
  look?: AgentMascotLook;
}

export interface TaskDetailPanelProps {
  task: TeamWorkItem;
  agents: readonly TaskDetailAgent[];
  /** Candidate parents for "Inside"; the task itself is excluded. */
  tasks?: readonly TeamWorkItem[];
  onChange(patch: WorkTaskPatch): void;
  onComment?(text: string): void;
  onArchive(): void;
  onClose(): void;
}

type StatusValue = TeamWorkItem["status"];

export const TASK_STATUS_OPTIONS: readonly { value: StatusValue; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In progress" },
  { value: "in-review", label: "In review" },
  { value: "done", label: "Done" },
];

const LEGACY_STATUS: Partial<Record<StatusValue, StatusValue>> = {
  queued: "todo",
  running: "in-progress",
  completed: "done",
  "needs-approval": "in-review",
};

const PRIORITY_OPTIONS: readonly { value: TeamWorkPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const TITLE_DEBOUNCE_MS = 400;

// Legacy run-derived statuses have no picker entry; show the nearest one instead of a blank select.
export function taskStatusOption(status: StatusValue): StatusValue {
  if (TASK_STATUS_OPTIONS.some((option) => option.value === status)) return status;
  return LEGACY_STATUS[status] ?? "todo";
}

const fieldClass =
  "min-h-11 lg:min-h-8 w-full min-w-0 rounded-md bg-transparent px-2 text-[13px] text-[var(--fg,#0a0a0a)] hover:bg-[var(--secondary,rgba(0,0,0,0.05))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring,#a1a1aa)] dark:[color-scheme:dark]";
const iconButtonClass =
  "size-11 lg:size-7 rounded-md flex items-center justify-center text-[var(--icon-muted,#71717a)] hover:text-[var(--fg,#0a0a0a)] hover:bg-[var(--secondary,rgba(0,0,0,0.05))] transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring,#a1a1aa)]";

function PropertyRow({
  icon,
  label,
  htmlFor,
  children,
}: {
  icon: ReactNode;
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const labelClass =
    "flex w-28 shrink-0 items-center gap-2 text-[13px] text-[var(--muted-foreground-2,#71717a)]";
  return (
    <div className="flex min-h-11 items-center gap-2 lg:min-h-9">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {icon}
          {label}
        </label>
      ) : (
        <span className={labelClass}>
          {icon}
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function TaskDetailPanel({
  task,
  agents,
  tasks = [],
  onChange,
  onComment,
  onArchive,
  onClose,
}: TaskDetailPanelProps): JSX.Element {
  const [title, setTitle] = useState(task.title);
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    title: string;
    save(patch: WorkTaskPatch): void;
  } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const flushTitle = () => {
    const edit = pending.current;
    if (!edit) return;
    clearTimeout(edit.timer);
    pending.current = null;
    const next = edit.title.trim();
    if (next) edit.save({ title: next });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching tasks or unmounting saves the in-flight edit to the task it was typed into.
  useEffect(() => {
    setTitle(task.title);
    return flushTitle;
  }, [task.id]);

  useEffect(() => {
    if (!pending.current) setTitle(task.title);
  }, [task.title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const editTitle = (value: string) => {
    setTitle(value);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      title: value,
      save: onChange,
      timer: setTimeout(flushTitle, TITLE_DEBOUNCE_MS),
    };
  };

  const owner = agents.find((agent) => agent.id === task.ownerId);
  const reviewer = agents.find((agent) => agent.id === task.reviewerId);
  const parents = tasks.filter((candidate) => candidate.id !== task.id && !candidate.archived);
  const id = (field: string) => `task-${task.id}-${field}`;
  const iconClass = "size-4 shrink-0";

  return (
    <aside
      aria-label="Task details"
      className="flex h-full w-full flex-col overflow-hidden border-l border-zinc-200 bg-[var(--bg,#fff)] text-[var(--fg,#0a0a0a)] dark:border-zinc-800 lg:w-[510px]"
    >
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="text-[14px] font-medium">Task</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onArchive}
            aria-label="Archive task"
            title="Archive task"
            className={iconButtonClass}
          >
            <Archive className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close task"
            title="Close (Esc)"
            className={iconButtonClass}
          >
            <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
        <textarea
          aria-label="Task title"
          value={title}
          rows={1}
          placeholder="Untitled task"
          onChange={(event) => editTitle(event.target.value)}
          onBlur={() => {
            flushTitle();
            if (!title.trim()) setTitle(task.title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className="mb-4 mt-2 w-full resize-none overflow-hidden bg-transparent font-serif text-[26px] leading-tight [field-sizing:content] placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring,#a1a1aa)] rounded-md"
        />

        <div className="flex flex-col gap-0.5">
          <PropertyRow
            icon={<CircleDashed className={iconClass} aria-hidden="true" />}
            label="Status"
            htmlFor={id("status")}
          >
            <select
              id={id("status")}
              value={taskStatusOption(task.status)}
              onChange={(event) => onChange({ status: event.target.value as StatusValue })}
              className={fieldClass}
            >
              {TASK_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </PropertyRow>

          <PropertyRow
            icon={<UserRound className={iconClass} aria-hidden="true" />}
            label="Owner"
            htmlFor={id("owner")}
          >
            {owner ? (
              <AgentAvatar id={owner.id} name={owner.name} mascotPreset={owner.mascotPreset} look={owner.look} role={owner.role} size={20} decorative />
            ) : null}
            <select
              id={id("owner")}
              value={task.ownerId ?? ""}
              onChange={(event) => onChange({ ownerId: event.target.value || undefined })}
              className={fieldClass}
            >
              <option value="">Assign a person or agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </PropertyRow>

          <PropertyRow
            icon={<UserCheck className={iconClass} aria-hidden="true" />}
            label="Reviewer"
            htmlFor={id("reviewer")}
          >
            {reviewer ? (
              <AgentAvatar
                id={reviewer.id}
                name={reviewer.name}
                mascotPreset={reviewer.mascotPreset}
                look={reviewer.look}
                role={reviewer.role}
                size={20}
                decorative
              />
            ) : null}
            <select
              id={id("reviewer")}
              value={task.reviewerId ?? ""}
              onChange={(event) => onChange({ reviewerId: event.target.value || undefined })}
              className={fieldClass}
            >
              <option value="">None</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </PropertyRow>

          <PropertyRow
            icon={<ChartNoAxesColumn className={iconClass} aria-hidden="true" />}
            label="Priority"
            htmlFor={id("priority")}
          >
            <select
              id={id("priority")}
              value={task.priority && task.priority !== "none" ? task.priority : "medium"}
              onChange={(event) => onChange({ priority: event.target.value as TeamWorkPriority })}
              className={fieldClass}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </PropertyRow>

          <PropertyRow
            icon={<CalendarDays className={iconClass} aria-hidden="true" />}
            label="Dates"
          >
            <input
              type="date"
              aria-label="Start date"
              value={task.startDate ?? ""}
              max={task.endDate || undefined}
              onChange={(event) => onChange({ startDate: event.target.value || undefined })}
              className={fieldClass}
            />
            <span className="shrink-0 text-[13px] text-[var(--muted-foreground-2,#71717a)]">
              to
            </span>
            <input
              type="date"
              aria-label="End date"
              value={task.endDate ?? ""}
              min={task.startDate || undefined}
              onChange={(event) => onChange({ endDate: event.target.value || undefined })}
              className={fieldClass}
            />
          </PropertyRow>

          <PropertyRow
            icon={<CornerLeftUp className={iconClass} aria-hidden="true" />}
            label="Inside"
            htmlFor={id("parent")}
          >
            <select
              id={id("parent")}
              value={task.parentId ?? ""}
              onChange={(event) => onChange({ parentId: event.target.value || undefined })}
              className={fieldClass}
            >
              <option value="">Not inside another task</option>
              {task.parentId && !parents.some((parent) => parent.id === task.parentId) ? (
                <option value={task.parentId}>Unavailable task</option>
              ) : null}
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.title}
                </option>
              ))}
            </select>
          </PropertyRow>

          <PropertyRow
            icon={<OctagonAlert className={iconClass} aria-hidden="true" />}
            label="Blocked"
            htmlFor={id("blocked")}
          >
            <button
              id={id("blocked")}
              type="button"
              role="switch"
              aria-checked={task.blocked === true}
              onClick={() => onChange({ blocked: !task.blocked })}
              className="relative ml-2 inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-zinc-300 transition-colors motion-reduce:transition-none aria-checked:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--ring,#a1a1aa)] dark:bg-zinc-600"
            >
              <span
                aria-hidden="true"
                className={`inline-block size-4 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${task.blocked ? "translate-x-[18px]" : "translate-x-0.5"}`}
              />
            </button>
          </PropertyRow>
        </div>

        <div className="mt-6 flex flex-col gap-6">
          <TaskDetailSections task={task} onChange={onChange} tasks={tasks} />
          <TaskActivity
            task={task}
            onComment={(text) => onComment?.(text)}
            actorNames={Object.fromEntries(agents.map((agent) => [agent.id, agent.name]))}
          />
        </div>
      </div>
    </aside>
  );
}
