import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { Clock, LayoutGrid, List, Plus, Search, X } from "lucide-react";
import type { RetainedRun, StoredApproval } from "../types";
import { formatTimeAgo, parseRepoName, statusLabel, type PendingApproval as ChatPendingApproval } from "../ui-helpers";
import type { SessionItem } from "./SessionsSidebar";
import { ViewGroup, ViewHeader, viewButtonClass } from "./ui/ViewChrome";
import { selectTeamWorkItems, type TeamWorkFilter, type TeamWorkItem } from "../team-work-items";

export type WorkViewMode = "list" | "board" | "timeline";
export interface WorkTask {
  id: string;
  kind: "approval" | "run" | "session";
  title: string;
  repo: string;
  group: "needs-approval" | "running" | "pr-open" | "attention" | "done";
  stateLabel: string;
  updatedAt: number;
}
export interface WorkViewProps {
  runs?: RetainedRun[];
  sessions?: SessionItem[];
  storedApprovals?: StoredApproval[];
  pendingApprovals?: ChatPendingApproval[];
  onSelectTask?: (id: string, kind: WorkTask["kind"]) => void;
  onNewTask?: () => void;
  onQuickAddTask?: (task: string) => Promise<boolean>;
  onReviewApproval?: (approvalId: string) => void;
  /** Supplied only after current workspace membership has been verified. */
  workspaceId?: string;
  workspaceName?: string;
  currentActorId?: string;
  sharedTasks?: readonly TeamWorkItem[];
  sharedTasksLoading?: boolean;
  sharedTasksError?: string;
  onOpenSharedTask?: (task: TeamWorkItem) => void;
  onOpenTeam?: () => void;
}
const STATUS_GROUPS = [
  { id: "needs-approval", name: "Needs approval", dotClass: "bg-[var(--warning)]" },
  { id: "running", name: "Running", dotClass: "bg-[var(--primary)] animate-pulse-subtle" },
  { id: "pr-open", name: "PR open", dotClass: "bg-[var(--success)]" },
  { id: "attention", name: "Needs attention", dotClass: "bg-[var(--destructive)]" },
  { id: "done", name: "Done", dotClass: "bg-[var(--muted-foreground-3)]" },
] as const;

export function WorkView(props: WorkViewProps): JSX.Element {
  // A distinct component/key prevents personal drafts and team filters crossing scopes.
  return props.workspaceId ? <TeamWorkView key={props.workspaceId} {...props} workspaceId={props.workspaceId} /> : <PersonalWorkView {...props} />;
}

function PersonalWorkView({ runs = [], sessions = [], storedApprovals = [], pendingApprovals = [], onSelectTask, onNewTask, onQuickAddTask, onReviewApproval }: WorkViewProps): JSX.Element {
  const [viewMode, setViewMode] = useState<WorkViewMode>("list");
  const [quickTaskText, setQuickTaskText] = useState("");
  const [quickTaskPending, setQuickTaskPending] = useState(false);
  const quickTaskInFlight = useRef(false);
  const [quickTaskError, setQuickTaskError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const focusSearch = useCallback((input: HTMLInputElement | null) => { input?.focus(); }, []);
  const tasks = useMemo(() => {
    const map = new Map<string, WorkTask>();
    for (const a of storedApprovals) {
      if (a.status !== "pending") continue;
      map.set(`approval-${a.approvalId}`, { id: a.approvalId, kind: "approval", title: a.task || "Pending approval request", repo: parseRepoName(a.repoUrl) || "", group: "needs-approval", stateLabel: "Needs approval", updatedAt: a.createdAt });
    }
    // Chat approval metadata has no timestamp or repository; keep unknown values undated.
    for (const p of pendingApprovals) {
      const key = `approval-${p.approvalId}`;
      if (!map.has(key)) map.set(key, { id: p.approvalId, kind: "approval", title: `Approve tool: ${p.tool}`, repo: "", group: "needs-approval", stateLabel: "Needs approval", updatedAt: 0 });
    }
    for (const r of runs) {
      if (r.archivedAt !== undefined) continue;
      const group: WorkTask["group"] = r.status === "running" || r.status === "pending" ? "running" : r.status !== "completed" ? "attention" : r.pullUrl ? "pr-open" : "done";
      map.set(`run-${r.runId}`, { id: r.runId, kind: "run", title: r.task || "Untitled run", repo: parseRepoName(r.repoUrl) || "", group, stateLabel: group === "attention" ? statusLabel(r.status) : STATUS_GROUPS.find((g) => g.id === group)!.name, updatedAt: r.updatedAt || r.createdAt });
    }
    const runIds = new Set(runs.map((r) => r.runId));
    for (const s of sessions) {
      if (s.id === "default" || runIds.has(s.id)) continue;
      const group: WorkTask["group"] = s.status === "waiting-approval" ? "needs-approval" : s.status === "running" || s.live ? "running" : ["error", "failed", "aborted", "cancelled", "unknown"].includes(s.status) ? "attention" : "done";
      map.set(`session-${s.id}`, { id: s.id, kind: "session", title: s.title || "Untitled thread", repo: s.repoName || "", group, stateLabel: group === "attention" ? statusLabel(s.status) : STATUS_GROUPS.find((g) => g.id === group)!.name, updatedAt: s.updatedAt });
    }
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [runs, sessions, storedApprovals, pendingApprovals]);
  const q = filterQuery.trim().toLowerCase();
  const filteredTasks = tasks.filter((t) => !q || `${t.title} ${t.repo} ${t.stateLabel}`.toLowerCase().includes(q));
  const openCount = tasks.filter((t) => t.group === "needs-approval" || t.group === "running" || t.group === "pr-open").length;
  const selectTask = (task: WorkTask) => onSelectTask?.(task.id, task.kind);
  const taskRow = (task: WorkTask) => {
    const dotClass = STATUS_GROUPS.find((g) => g.id === task.group)!.dotClass;
    return (
      <div key={`${task.kind}-${task.id}`} className={viewMode === "board" ? "rounded-lg border border-[var(--border-1)] bg-[var(--card)] p-3 shadow-plate" : viewMode === "timeline" ? "relative rounded-lg border border-[var(--border-1)] bg-[var(--card)] p-3 shadow-plate" : "border-b border-[var(--border-1)]"}>
        {viewMode === "timeline" ? <span aria-hidden="true" className={`absolute -left-[31px] top-4 size-3 rounded-full border-2 border-[var(--bg)] ${dotClass}`} /> : null}
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => selectTask(task)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded px-3 text-left hover:bg-[var(--card-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass}`} />
            <span className="min-w-0 flex-1 text-[13px] text-[var(--fg)]">{task.title}</span>
            {task.repo ? <span className="shrink-0 font-mono text-xs text-[var(--muted-foreground-2)]">{task.repo}</span> : null}
            <span className="rounded-full bg-[var(--section)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground-1)]">{task.stateLabel}</span>
            {viewMode !== "list" && task.updatedAt > 0 ? <span className="text-xs text-[var(--muted-foreground-3)]">{formatTimeAgo(task.updatedAt)}</span> : null}
          </button>
          {task.group === "needs-approval" && onReviewApproval ? <button type="button" onClick={() => onReviewApproval(task.id)} className={viewButtonClass}>Review</button> : null}
        </div>
      </div>
    );
  };
  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <ViewHeader section="Work" view={viewMode === "list" ? "List" : viewMode === "board" ? "Board" : "Timeline"} count={`${openCount} open`}>
        {searchOpen ? <input id="work-search" type="search" aria-label="Filter tasks" placeholder="Filter tasks…" value={filterQuery} onChange={(e) => setFilterQuery(e.target.value)} ref={focusSearch} className="min-h-11 w-40 rounded-lg border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm" /> : null}
        <button type="button" aria-label={searchOpen ? "Close search" : "Search tasks"} aria-expanded={searchOpen} aria-controls="work-search" onClick={() => { setSearchOpen(!searchOpen); setFilterQuery(""); }} className={viewButtonClass}>{searchOpen ? <X className="size-4" /> : <Search className="size-4" />}</button>
        <div role="group" aria-label="Work views" className="flex gap-1 rounded-lg bg-[var(--secondary)] p-1">
          {([ ["list", "List", List], ["board", "Board", LayoutGrid], ["timeline", "Timeline", Clock] ] as const).map(([mode, label, Icon]) => <button key={mode} type="button" aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)} className={`flex min-h-11 items-center gap-1.5 rounded-md px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${viewMode === mode ? "bg-[var(--card)] text-[var(--fg)] shadow-plate" : "text-[var(--muted-foreground-2)]"}`}><Icon aria-hidden="true" className="size-3.5" />{label}</button>)}
        </div>
        <button type="button" onClick={onNewTask} className={viewButtonClass}><Plus aria-hidden="true" className="size-4" />New task</button>
      </ViewHeader>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-6">
        <form aria-busy={quickTaskPending} onSubmit={async (e) => {
          e.preventDefault();
          const text = quickTaskText.trim();
          if (!text || !onQuickAddTask || quickTaskInFlight.current) return;
          quickTaskInFlight.current = true;
          setQuickTaskPending(true);
          setQuickTaskError(null);
          try {
            if (await onQuickAddTask(text)) setQuickTaskText("");
          } catch {
            setQuickTaskError("Could not create a thread. Your draft has been kept. Try again.");
          } finally {
            quickTaskInFlight.current = false;
            setQuickTaskPending(false);
          }
        }}>
          <label className="flex min-h-12 items-center gap-3 rounded-lg border border-dashed border-[var(--border-2)] bg-[var(--card)] px-4 focus-within:border-[var(--primary)]"><Plus aria-hidden="true" className="size-4 text-[var(--icon-muted)]" /><input value={quickTaskText} disabled={quickTaskPending || !onQuickAddTask} onChange={(e) => setQuickTaskText(e.target.value)} placeholder="Draft a task and press Enter" aria-label="Draft a task and press Enter" className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none disabled:opacity-60" /></label>
          {quickTaskError ? <p role="alert" className="mt-2 text-sm text-[var(--destructive)]">{quickTaskError}</p> : null}
        </form>
        <section aria-label={`${viewMode === "list" ? "List" : viewMode === "board" ? "Board" : "Timeline"} view`} className={viewMode === "board" ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" : viewMode === "timeline" ? "ml-4 flex flex-col gap-6 border-l-2 border-[var(--border-1)] pl-6" : "flex flex-col gap-6"}>
          {viewMode === "timeline" ? filteredTasks.length ? filteredTasks.map(taskRow) : <p className="py-12 text-center text-sm text-[var(--muted-foreground-2)]">No tasks to display in timeline</p> : STATUS_GROUPS.map((group) => {
            const grouped = filteredTasks.filter((t) => t.group === group.id);
            return <section key={group.id} aria-label={`${group.name} - ${grouped.length}`}><ViewGroup title={group.name} count={grouped.length} dotClass={group.dotClass}>{grouped.length ? grouped.map(taskRow) : <p className="px-3 py-3 text-xs text-[var(--muted-foreground-3)]">{group.id === "needs-approval" ? "Nothing waiting" : `No tasks in ${group.name}`}</p>}</ViewGroup></section>;
          })}
        </section>
      </div>
    </div>
  );
}

const TEAM_STATUS_GROUPS = [
  { id: "needs-approval", name: "Needs approval", dotClass: "bg-[var(--warning)]" },
  { id: "queued", name: "Queued", dotClass: "bg-[var(--muted-foreground-2)]" },
  { id: "running", name: "Running", dotClass: "bg-[var(--primary)]" },
  { id: "blocked", name: "Blocked", dotClass: "bg-[var(--destructive)]" },
  { id: "completed", name: "Completed", dotClass: "bg-[var(--success)]" },
  { id: "cancelled", name: "Cancelled", dotClass: "bg-[var(--muted-foreground-3)]" },
  { id: "unknown", name: "Status unavailable", dotClass: "bg-[var(--muted-foreground-3)]" },
] as const;

function TeamWorkView({ workspaceId, workspaceName, currentActorId, sharedTasks = [], sharedTasksLoading = false, sharedTasksError, onOpenSharedTask, onOpenTeam }: WorkViewProps & { workspaceId: string }): JSX.Element {
  const [viewMode, setViewMode] = useState<WorkViewMode>("list");
  const [filter, setFilter] = useState<TeamWorkFilter>("all");
  const [query, setQuery] = useState("");
  // An authorization/loading failure must never leave cached room data visible.
  const authorizedTasks = sharedTasksError ? [] : sharedTasks;
  const scopeTasks = selectTeamWorkItems(authorizedTasks, workspaceId, "all", currentActorId);
  const q = query.trim().toLowerCase();
  const tasks = selectTeamWorkItems(authorizedTasks, workspaceId, filter, currentActorId).filter((task) => !q || `${task.title} ${task.roomTitle} ${task.assigneeName ?? ""} ${TEAM_STATUS_GROUPS.find((group) => group.id === task.status)?.name ?? "Status unavailable"}`.toLowerCase().includes(q));
  const filters = [
    { id: "all", name: "All shared work" },
    { id: "assigned", name: "Assigned to me" },
    { id: "needs-you", name: "Needs you" },
  ] as const;
  const taskCard = (task: TeamWorkItem) => {
    const group = TEAM_STATUS_GROUPS.find((item) => item.id === task.status) ?? TEAM_STATUS_GROUPS[6];
    return <article key={task.id} className={`min-w-0 border border-[var(--border-1)] bg-[var(--card)] ${viewMode === "timeline" ? "relative" : ""}`}>
      {viewMode === "timeline" ? <span aria-hidden="true" className={`absolute -left-[31px] top-5 size-2 rounded-full ${group.dotClass}`} /> : null}
      <div className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground-2)]">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${group.dotClass}`} />
          <span className="font-mono">{group.name}</span>
          {task.updatedAt > 0 ? <span className="ml-auto whitespace-nowrap">{formatTimeAgo(task.updatedAt)}</span> : null}
        </div>
        <h3 className="break-words text-sm font-medium leading-6">{task.title}</h3>
        <p className="break-words text-xs text-[var(--muted-foreground-2)]">{task.assigneeKind === "agent" ? "Employee" : "Human"} · {task.assigneeName || "Name unavailable"}</p>
        <p className="break-words text-xs text-[var(--muted-foreground-2)]">Room · {task.roomTitle}</p>
        {task.resultAvailable === false ? <p className="text-xs text-[var(--muted-foreground-2)]">Result unavailable</p> : task.resultAvailable === true ? <p className="text-xs text-[var(--success)]">Result available in room</p> : null}
        {onOpenSharedTask ? <button type="button" onClick={() => onOpenSharedTask(task)} aria-label={`Open ${task.title} in ${task.roomTitle}`} className={`${viewButtonClass} w-full !rounded-none sm:w-fit`}>Open task in room</button> : null}
      </div>
    </article>;
  };

  return <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--chrome)] px-4 py-3 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--muted-foreground-2)]">
        <span className="max-w-full break-words">{workspaceName || "Workspace"}</span><span aria-hidden="true">&gt;</span><h2 className="text-sm font-medium text-[var(--fg)]">Shared work</h2><span className="font-mono text-xs tabular-nums">{scopeTasks.length} tasks</span>
      </div>
      <fieldset aria-label="Work views" className="flex min-w-0 max-w-full flex-wrap gap-1 border border-[var(--border-1)] bg-[var(--secondary)] p-1">
        {([ ["list", "List", List], ["board", "Board", LayoutGrid], ["timeline", "Timeline", Clock] ] as const).map(([mode, label, Icon]) => <button key={mode} type="button" aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)} className={`flex min-h-11 items-center gap-1.5 px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${viewMode === mode ? "bg-[var(--card)] text-[var(--fg)] shadow-plate" : "text-[var(--muted-foreground-2)]"}`}><Icon aria-hidden="true" className="size-3.5" />{label}</button>)}
      </fieldset>
    </header>
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><h1 className="font-serif text-2xl">Work with your team</h1><p className="mt-1 text-sm text-[var(--muted-foreground-2)]">Shared handoffs, human assignments and employee runs. Open a room to see its context and available results.</p></div>
        {onOpenTeam ? <button type="button" onClick={onOpenTeam} className={`${viewButtonClass} !rounded-none`}>Team &amp; chat</button> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset aria-label="Shared work filters" className="flex min-w-0 max-w-full flex-wrap gap-1">
          {filters.map((item) => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} className={`${viewButtonClass} !rounded-none ${filter === item.id ? "bg-[var(--card)] shadow-plate" : ""}`}>{item.name}<span className="text-xs tabular-nums text-[var(--muted-foreground-2)]">{selectTeamWorkItems(authorizedTasks, workspaceId, item.id, currentActorId).length}</span></button>)}
        </fieldset>
        <label className="flex min-h-11 w-full min-w-0 items-center gap-2 border border-[var(--border-1)] bg-[var(--input)] px-3 sm:w-64"><Search aria-hidden="true" className="size-4 shrink-0 text-[var(--icon-muted)]" /><input type="search" aria-label="Filter shared work" placeholder="Filter shared work…" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" /></label>
      </div>
      {filter === "needs-you" ? <p className="text-xs text-[var(--muted-foreground-2)]">Pending approvals you are currently authorized to review. Decisions are made in the task’s room.</p> : null}
      {sharedTasksError ? <p role="alert" className="text-sm text-[var(--destructive)]">{sharedTasksError}</p> : null}
      {sharedTasksLoading ? <p role="status" className="text-sm text-[var(--muted-foreground-2)]">Loading shared work…</p> : null}
      <section aria-label={`${viewMode === "list" ? "List" : viewMode === "board" ? "Board" : "Timeline"} view`} className={tasks.length === 0 ? "" : viewMode === "board" ? "grid min-w-0 grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3" : viewMode === "timeline" ? "ml-4 flex min-w-0 flex-col gap-4 border-l-2 border-[var(--border-1)] pl-6" : "flex min-w-0 flex-col gap-6"}>
        {tasks.length === 0 ? !sharedTasksLoading && !sharedTasksError ? <div className="border border-dashed border-[var(--border-2)] px-4 py-10 text-center"><p className="text-sm">{scopeTasks.length === 0 ? "No shared work yet" : "No shared work matches this view"}</p><p className="mt-2 text-xs text-[var(--muted-foreground-2)]">{scopeTasks.length === 0 ? "Create a handoff from a team room to track work here." : "Choose another filter or clear your search."}</p></div> : null : viewMode === "timeline" ? tasks.map(taskCard) : TEAM_STATUS_GROUPS.map((group) => {
          const grouped = tasks.filter((task) => task.status === group.id || group.id === "unknown" && !TEAM_STATUS_GROUPS.some((item) => item.id === task.status));
          return grouped.length ? <section key={group.id} aria-label={`${group.name} - ${grouped.length}`} className="min-w-0"><ViewGroup title={group.name} count={grouped.length} dotClass={group.dotClass}><div className="flex min-w-0 flex-col gap-2 pt-2">{grouped.map(taskCard)}</div></ViewGroup></section> : null;
        })}
      </section>
    </div>
  </div>;
}
