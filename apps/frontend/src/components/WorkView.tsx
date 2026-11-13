import { ListChecks, Search, X } from "lucide-react";
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTeamWorkAssignedToViewer, selectTeamWorkItems, type TeamWorkItem, teamWorkNeedsViewer } from "../team-work-items";
import type { RetainedRun, StoredApproval } from "../types";
import { type PendingApproval as ChatPendingApproval, parseRepoName, statusLabel } from "../ui-helpers";
import type { WorkTaskPatch } from "../work-mutations";
import { parseWorkSearch, updateWorkSearch, type WorkPeekTab, type WorkSearchState, type WorkTaskKind } from "../work-search";
import type { SessionItem } from "./SessionsSidebar";
import { type TaskDetailAgent, TaskDetailPanel } from "./TaskDetailPanel";
import { ViewGroup, viewButtonClass } from "./ui/ViewChrome";
import { WorkBoardView } from "./WorkBoardView";
import { WorkDetailModal } from "./WorkDetailModal";
import { WorkHeader, type WorkHeaderViewMode } from "./WorkHeader";
import { WorkLeftPanel, type WorkLeftPanelProps, type WorkScope } from "./WorkLeftPanel";
import { WorkListView, workListGroup } from "./WorkListView";
import { type OrganizationEmployee, type OrganizationUser, WorkOrganizationView } from "./WorkOrganizationView";
import { WorkPeek, type WorkPeekProps } from "./WorkPeek";
import { WorkQuickAdd } from "./WorkQuickAdd";
import { WorkTimelineView } from "./WorkTimelineView";

export type WorkViewMode = WorkHeaderViewMode;

export interface WorkTask {
  id: string;
  kind: WorkTaskKind;
  title: string;
  repo: string;
  group: "ready" | "needs-approval" | "queued" | "running" | "pr-open" | "attention" | "done";
  stateLabel: string;
  updatedAt: number;
  createdAt?: number;
  /** Original run/session status, used to keep failure kinds distinct on the board. */
  rawStatus?: string;
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
  view?: WorkViewMode;
  onViewChange?: (view: WorkViewMode) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  employees?: OrganizationEmployee[];
  onOpenEmployee?: (id: string) => void;
  /** Renders the Work left panel (scope tabs, nav, task sections) inside this view when given. */
  onScopeChange?: (scope: WorkScope) => void;
  /** Workspace scope: resolves to the created task, or null on failure (draft is kept). */
  onCreateTask?: (title: string) => Promise<TeamWorkItem | null>;
  onUpdateTask?: (id: string, patch: WorkTaskPatch) => unknown;
  onArchiveTask?: (id: string) => unknown;
  onCommentTask?: (id: string, text: string) => unknown;
  /** Owner/reviewer candidates for the task detail panel. */
  agents?: readonly TaskDetailAgent[];
  /** Signed-in user for the Organization chart heading. */
  user?: OrganizationUser;
  /** Existing approval handlers are passed through unchanged to the existing cards. */
  onDecideApproval?: WorkPeekProps["onDecideApproval"];
  onDecideStoredApproval?: WorkPeekProps["onDecideStoredApproval"];
  approvalDecisions?: Record<string, boolean>;
  /** Scope used by existing deliverable links; never guessed from a run id. */
  peekSessionId?: string;
  /** Existing app feedback must remain visible above the modal's inert background. */
  peekNotice?: ReactNode;
  /** Embed the selected thread's existing StepTimeline/RunLivePanel or fully loaded diff. */
  renderPeekContent?: (task: WorkTask, tab: WorkPeekTab) => ReactNode;
  /** Router adapter: receive the complete next Work state, preserving caller-owned search keys. */
  onSearchChange?: (state: WorkSearchState) => void;
  /** A new server-confirmed handoff may select an item without changing sessions. */
  requestedState?: WorkSearchState;
}

// replaceState keeps the app router's own history steps (one per page) untouched.
function writeWorkUrl(state: WorkSearchState): void {
  const params = updateWorkSearch(new URLSearchParams(window.location.search), state);
  const search = params.toString();
  const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, "", next);
  }
}

type PanelLists = Pick<WorkLeftPanelProps, "needsYou" | "assignedToMe" | "everything" | "selectedId" | "onOpenTask" | "onSearch">;
const personalTaskKey = (task: WorkTask) => `${task.kind}:${task.id}`;
function recordedDay(timestamp?: number): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  // Match the Timeline's local calendar and the inspector's local step timestamps.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The shell is nested inside the app frame, so it fills its parent instead of the viewport.
const SHELL_STYLE = { height: "100%", padding: 0, background: "transparent" } as const;

function workShell(props: WorkViewProps, lists: PanelLists, card: JSX.Element, detail?: { panel: JSX.Element; onClose: () => void }): JSX.Element {
  const showPanel = Boolean(props.onScopeChange) && !props.sidebarCollapsed;
  return (
    <div className="shiba-work-shell min-w-0 flex-1" style={SHELL_STYLE} data-work-surface tabIndex={-1} data-context={showPanel ? undefined : "collapsed"} data-detail={detail ? "open" : undefined}>
      {showPanel && props.onScopeChange ? (
        <WorkLeftPanel
          scope={props.workspaceId ? "workspace" : "personal"}
          onScopeChange={props.onScopeChange}
          view={props.view ?? "list"}
          onViewChange={props.onViewChange ?? (() => {})}
          {...lists}
        />
      ) : null}
      {card}
      {detail ? (
        <WorkDetailModal label="Task inspector" onClose={detail.onClose} compact>{detail.panel}</WorkDetailModal>
      ) : null}
    </div>
  );
}

const STATUS_GROUPS = [
  { id: "ready", name: "Ready", dotClass: "bg-[var(--muted-foreground-3)]" },
  { id: "needs-approval", name: "Needs approval", dotClass: "bg-[var(--warning)]" },
  { id: "queued", name: "Queued", dotClass: "bg-[var(--muted-foreground-2)]" },
  { id: "running", name: "Running", dotClass: "bg-[var(--primary)] animate-pulse-subtle" },
  { id: "pr-open", name: "PR linked", dotClass: "bg-[var(--success)]" },
  { id: "attention", name: "Needs attention", dotClass: "bg-[var(--destructive)]" },
  { id: "done", name: "Completed", dotClass: "bg-[var(--muted-foreground-3)]" },
] as const;

/** One status mapping for Board and Timeline so cancelled, PR open and needs-provider read the same in both. */
function workStatus(task: WorkTask, approvalStatus: "needs-approval" | "waiting-approval"): string {
  if (task.group === "ready") return "ready";
  if (task.group === "needs-approval") return approvalStatus;
  if (task.group === "running") return "running";
  if (task.group === "queued") return "pending";
  if (task.group === "pr-open") return "pr-open";
  if (task.group === "attention") return task.rawStatus ?? "unknown";
  return "completed";
}

export function WorkView(props: WorkViewProps): JSX.Element {
  const { view: controlledView, onViewChange } = props;
  // Read browser state after hydration so the first client paint matches the server.
  const [internalView, setInternalView] = useState<WorkViewMode>("list");
  const [selection, setSelection] = useState<Pick<WorkSearchState, "task" | "taskKind" | "tab">>({ task: null, tab: "steps" });
  const [urlReady, setUrlReady] = useState(false);
  const view = controlledView ?? internalView;
  const setView = useCallback((mode: WorkViewMode) => {
    setInternalView(mode);
    onViewChange?.(mode);
  }, [onViewChange]);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    const read = (initial = false) => {
      const state = parseWorkSearch(new URLSearchParams(window.location.search));
      setInternalView(state.view);
      setSelection({ task: state.task, taskKind: state.taskKind, tab: state.tab });
      if (!initial || new URLSearchParams(window.location.search).has("view")) onViewChangeRef.current?.(state.view);
      setUrlReady(true);
    };
    read(true);
    const onPop = () => read();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!props.requestedState) return;
    const state = props.requestedState;
    setInternalView(state.view);
    onViewChangeRef.current?.(state.view);
    setSelection({ task: state.task, taskKind: state.taskKind, tab: state.tab });
    setUrlReady(true);
  }, [props.requestedState]);
  const onSearchChangeRef = useRef(props.onSearchChange);
  onSearchChangeRef.current = props.onSearchChange;
  useEffect(() => {
    if (!urlReady) return;
    const state = { view, ...selection };
    if (onSearchChangeRef.current) onSearchChangeRef.current(state);
    else writeWorkUrl(state);
  }, [view, selection, urlReady]);
  const setTaskId = useCallback((task: string | null) => setSelection({ task, tab: "steps" }), []);
  const setPersonalTask = useCallback((task: WorkTask, tab: WorkPeekTab = task.kind === "approval" ? "approval" : "steps") => {
    setSelection({ task: task.id, taskKind: task.kind, tab });
  }, []);
  const previousScope = useRef(props.workspaceId);
  useEffect(() => {
    if (previousScope.current === props.workspaceId) return;
    previousScope.current = props.workspaceId;
    setSelection({ task: null, tab: "steps" });
  }, [props.workspaceId]);

  const scoped = { ...props, view, onViewChange: setView };
  // A distinct component/key prevents personal drafts and team filters crossing scopes.
  return props.workspaceId ? (
    <TeamWorkView key={props.workspaceId} {...scoped} workspaceId={props.workspaceId} taskId={selection.task} onTaskChange={setTaskId} />
  ) : (
    <PersonalWorkView {...scoped} selection={selection} onOpenPeek={setPersonalTask} onClosePeek={() => setTaskId(null)} onPeekTabChange={(tab) => setSelection((current) => ({ ...current, tab }))} />
  );
}

interface PersonalWorkViewProps extends WorkViewProps {
  selection: Pick<WorkSearchState, "task" | "taskKind" | "tab">;
  onOpenPeek(task: WorkTask, tab?: WorkPeekTab): void;
  onClosePeek(): void;
  onPeekTabChange(tab: WorkPeekTab): void;
}

function PersonalWorkView(props: PersonalWorkViewProps): JSX.Element {
  const {
    runs = [],
    sessions = [],
    storedApprovals = [],
    pendingApprovals = [],
    onSelectTask,
    onNewTask,
    onQuickAddTask,
    onReviewApproval,
    view: activeView = "list",
    onViewChange: setView = () => {},
    sidebarCollapsed = false,
    onToggleSidebar,
    employees = [],
    onOpenEmployee,
  } = props;

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
      const group: WorkTask["group"] = r.status === "pending" ? "queued" : r.status === "running" ? "running" : r.status !== "completed" ? "attention" : r.pullUrl ? "pr-open" : "done";
      map.set(`run-${r.runId}`, { id: r.runId, kind: "run", title: r.task || "Untitled run", repo: parseRepoName(r.repoUrl) || "", group, stateLabel: group === "attention" ? statusLabel(r.status) : STATUS_GROUPS.find((g) => g.id === group)!.name, createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt, rawStatus: r.status });
    }
    const runIds = new Set(runs.map((r) => r.runId));
    for (const s of sessions) {
      if (s.id === "default" || runIds.has(s.id)) continue;
      const group: WorkTask["group"] = s.status === "waiting-approval" || s.status === "needs-approval" ? "needs-approval" : s.status === "running" || s.status === "live" || s.live ? "running" : s.status === "pending" || s.status === "queued" ? "queued" : s.status === "completed" ? "done" : s.status === "ready" ? "ready" : "attention";
      map.set(`session-${s.id}`, { id: s.id, kind: "session", title: s.title || "Untitled thread", repo: s.repoName || "", group, stateLabel: statusLabel(s.status), updatedAt: s.updatedAt, rawStatus: s.status });
    }
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [runs, sessions, storedApprovals, pendingApprovals]);

  const q = filterQuery.trim().toLowerCase();
  const filteredTasks = tasks.filter((t) => !q || `${t.title} ${t.repo} ${t.stateLabel}`.toLowerCase().includes(q));
  const openCount = tasks.filter((t) => t.group === "needs-approval" || t.group === "queued" || t.group === "running" || t.group === "pr-open").length;
  const selected = tasks.find((task) => task.id === props.selection.task && (!props.selection.taskKind || task.kind === props.selection.taskKind));
  const resolvedSelection = useRef<string | null>(null);
  const selectionKey = JSON.stringify([props.selection.taskKind, props.selection.task]);
  useEffect(() => {
    if (selected) resolvedSelection.current = selectionKey;
    else if (resolvedSelection.current === selectionKey) props.onClosePeek();
  }, [selected, selectionKey, props.onClosePeek]);

  const handleOpenTask = useCallback((id: string) => {
    const task = tasks.find((t) => personalTaskKey(t) === id);
    if (task) {
      props.onOpenPeek(task);
    }
  }, [tasks, props.onOpenPeek]);
  const handleReviewTask = (id: string) => {
    const task = tasks.find((item) => personalTaskKey(item) === id);
    if (task) props.onOpenPeek(task, "approval");
  };

  const boardTasks = useMemo(() => {
    return filteredTasks.map((t) => ({
      id: personalTaskKey(t),
      title: t.title,
      status: workStatus(t, "needs-approval"),
      updatedAt: t.updatedAt,
      repoName: t.repo,
    }));
  }, [filteredTasks]);

  const timelineTasks = useMemo(() => {
    return filteredTasks.map((t) => ({
      id: personalTaskKey(t),
      title: t.title,
      status: workStatus(t, "waiting-approval"),
      updatedAt: t.updatedAt,
      repoName: t.repo,
      startDate: recordedDay(t.createdAt),
      endDate: recordedDay(t.updatedAt),
    }));
  }, [filteredTasks]);

  const taskRow = (task: WorkTask) => {
    const dotClass = STATUS_GROUPS.find((g) => g.id === task.group)!.dotClass;
    return (
      <div key={`${task.kind}-${task.id}`} className="border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => props.onOpenPeek(task)}
            aria-haspopup="dialog"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded px-3 text-left hover:bg-[var(--card-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          >
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass}`} />
            <span className="min-w-0 flex-1 text-[13px] text-[var(--fg)]">{task.title}</span>
            {task.repo ? <span className="shrink-0 font-mono text-xs text-[var(--muted-foreground-2)]">{task.repo}</span> : null}
            <span className="rounded-full bg-[var(--section)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground-1)]">{task.stateLabel}</span>
          </button>
          {task.group === "needs-approval" && task.rawStatus !== "needs-provider" && onReviewApproval ? (
            <button type="button" onClick={() => props.onOpenPeek(task, "approval")} className={viewButtonClass}>
              Review
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const viewTitle = activeView.charAt(0).toUpperCase() + activeView.slice(1);
  const crumbs = ["Personal", "Work", viewTitle];
  const panelTask = (t: WorkTask) => ({ id: personalTaskKey(t), title: t.title, status: workStatus(t, "needs-approval") });
  const panelLists: PanelLists = {
    needsYou: tasks.filter((t) => t.group === "needs-approval").map(panelTask),
    // Personal runs and threads carry no human assignee, so this stays a real empty state.
    assignedToMe: [],
    everything: tasks.filter((t) => t.group !== "done").map(panelTask),
    selectedId: selected ? personalTaskKey(selected) : undefined,
    onOpenTask: handleOpenTask,
    onSearch: () => setSearchOpen(true),
  };

  const card = (
    <div className="shiba-main-card h-full text-[var(--fg)]">
      <WorkHeader
        crumbs={crumbs}
        countLabel={`${openCount} open`}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar ?? (() => {})}
        searchOpen={searchOpen}
        onSearch={() => {
          setSearchOpen((prev) => !prev);
          if (searchOpen) setFilterQuery("");
        }}
        onNewTask={onNewTask ?? (() => {})}
        activeView={activeView}
        onViewChange={setView}
        className="border-b border-zinc-200 dark:border-zinc-800"
      />
      {props.selection.task && !selected ? <div role="status" className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2 text-xs">
        <p>The selected item is not in the currently loaded work list.</p>
        <button type="button" className={viewButtonClass} onClick={props.onClosePeek}>Clear selection</button>
      </div> : null}

      {searchOpen ? (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 shrink-0 bg-zinc-50/50 dark:bg-zinc-800/40">
          <Search className="size-4 text-zinc-400 shrink-0" aria-hidden="true" />
          <input
            id="work-search"
            type="search"
            aria-label="Filter tasks"
            placeholder="Filter tasks…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            ref={focusSearch}
            className="min-h-11 lg:min-h-8 w-full bg-transparent text-sm outline-none placeholder:text-zinc-400 text-zinc-900 dark:text-zinc-100"
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setFilterQuery("");
            }}
            className="size-11 lg:size-7 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      {/* Quick Add dashed row */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <WorkQuickAdd
          onSubmit={(text) => onQuickAddTask?.(text)}
          disabled={!onQuickAddTask}
            />
      </div>

      {/* Main body by view */}
      {activeView === "list" ? (
        <section aria-label="List view" className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 flex flex-col">
          {tasks.length === 0 ? (
            <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center p-8 text-center select-none">
              <ListChecks
                className="mb-2 h-8 w-8 stroke-[1.5] text-zinc-400 dark:text-zinc-500"
                aria-hidden="true"
              />
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                No tasks yet
              </h3>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Add a task above to start a thread.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {STATUS_GROUPS.map((group) => {
                const grouped = filteredTasks.filter((t) => t.group === group.id);
                return (
                  <section key={group.id} aria-label={`${group.name} - ${grouped.length}`}>
                    <ViewGroup title={group.name} count={grouped.length} dotClass={group.dotClass}>
                      {grouped.length ? (
                        grouped.map(taskRow)
                      ) : (
                        <p className="px-3 py-3 text-xs text-[var(--muted-foreground-3)]">
                          {group.id === "needs-approval" ? "Nothing waiting" : `No tasks in ${group.name}`}
                        </p>
                      )}
                    </ViewGroup>
                  </section>
                );
              })}
            </div>
          )}
        </section>
      ) : activeView === "board" ? (
        <section aria-label="Board view" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <WorkBoardView
            execution
            agents={props.agents}
            tasks={boardTasks}
            onOpen={handleOpenTask}
            onReview={handleReviewTask}
            className="h-full"
          />
        </section>
      ) : activeView === "timeline" ? (
        <section aria-label="Timeline view" className="flex-1 flex flex-col min-h-0 overflow-y-auto px-4 pb-4">
          <p className="py-2 text-xs text-[var(--muted-foreground-2)]">Recorded activity dates, from creation to last update. Bars do not indicate scheduled duration or progress.</p>
          <WorkTimelineView
            tasks={timelineTasks}
            onOpen={handleOpenTask}
            onReview={handleReviewTask}
            className="h-full"
          />
        </section>
      ) : (
        <section aria-label="Organization view" className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          <WorkOrganizationView
            employees={employees}
            onOpen={onOpenEmployee}
            user={props.user}
          />
        </section>
      )}
    </div>
  );
  return <>
    {workShell(props, panelLists, card)}
    {selected ? <WorkPeek
      key={`${selected.kind}:${selected.id}`}
      task={selected}
      run={selected.kind === "run" ? runs.find((run) => run.runId === selected.id) : undefined}
      storedApproval={selected.kind === "approval" ? storedApprovals.find((approval) => approval.approvalId === selected.id) : undefined}
      pendingApproval={selected.kind === "approval" ? pendingApprovals.find((approval) => approval.approvalId === selected.id) : undefined}
      tab={props.selection.tab}
      onTabChange={props.onPeekTabChange}
      onClose={props.onClosePeek}
      onOpenFull={onSelectTask ? () => onSelectTask(selected.id, selected.kind) : undefined}
      onReviewApproval={onReviewApproval ? () => onReviewApproval(selected.id) : undefined}
      sessionId={props.peekSessionId}
      notice={props.peekNotice}
      decisions={props.approvalDecisions}
      onDecideApproval={props.onDecideApproval}
      onDecideStoredApproval={props.onDecideStoredApproval}
      renderContent={props.renderPeekContent}
    /> : null}
  </>;
}

interface TeamWorkViewProps extends WorkViewProps {
  workspaceId: string;
  taskId: string | null;
  onTaskChange: (id: string | null) => void;
}

function TeamWorkView(props: TeamWorkViewProps): JSX.Element {
  const {
    workspaceId,
    currentActorId,
    sharedTasks = [],
    sharedTasksLoading = false,
    sharedTasksError,
    view = "list",
    onViewChange = () => {},
    sidebarCollapsed = false,
    onToggleSidebar,
    onNewTask,
    onCreateTask,
    onUpdateTask,
    onArchiveTask,
    onCommentTask,
    agents = [],
    employees = [],
    onOpenEmployee,
    user,
    taskId,
    onTaskChange,
  } = props;
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const quickAddRef = useRef<HTMLDivElement>(null);
  const focusSearch = useCallback((input: HTMLInputElement | null) => { input?.focus(); }, []);

  // An authorization/loading failure must never leave cached room data visible.
  const all = selectTeamWorkItems(sharedTasksError ? [] : sharedTasks, workspaceId, "all", currentActorId);
  const q = query.trim().toLowerCase();
  const tasks = all.filter((task) => !q || `${task.title} ${task.assigneeName ?? ""}`.toLowerCase().includes(q));
  const open = all.filter((task) => workListGroup(task.status) !== "done");
  const selected = taskId ? all.find((task) => task.id === taskId) : undefined;

  const toggleDone = (id: string) => {
    const task = all.find((item) => item.id === id);
    if (task) onUpdateTask?.(id, { status: workListGroup(task.status) === "done" ? "todo" : "done" });
  };
  const newTask = () => {
    const input = quickAddRef.current?.querySelector("input");
    if (onCreateTask && input) input.focus();
    else onNewTask?.();
  };
  const viewTitle = view.charAt(0).toUpperCase() + view.slice(1);

  const card = (
    <div className="shiba-main-card h-full text-[var(--fg)]">
      <WorkHeader
        crumbs={selected ? ["Workspace", "Work", viewTitle, selected.title || "Untitled task"] : ["Workspace", "Work", viewTitle]}
        countLabel={`${open.length} open`}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar ?? (() => {})}
        searchOpen={searchOpen}
        onSearch={() => {
          setSearchOpen((prev) => !prev);
          if (searchOpen) setQuery("");
        }}
        onNewTask={newTask}
        activeView={view}
        onViewChange={onViewChange}
        className="border-b border-zinc-200 dark:border-zinc-800"
      />
      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50/50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <Search className="size-4 shrink-0 text-zinc-400" aria-hidden="true" />
          <input
            id="work-search"
            type="search"
            aria-label="Filter tasks"
            placeholder="Filter tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            ref={focusSearch}
            className="min-h-11 w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 lg:min-h-8 dark:text-zinc-100"
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            className="flex size-11 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 lg:size-7 dark:hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {sharedTasksError ? <p role="alert" className="px-4 pt-3 text-sm text-[var(--destructive-fg)]">{sharedTasksError}</p> : null}
      {sharedTasksLoading ? <p role="status" className="px-4 pt-3 text-sm text-[var(--muted-foreground-2)]">Loading work…</p> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view !== "organization" ? (
            <div ref={quickAddRef} className="shrink-0 px-4 pt-3 pb-2">
              <WorkQuickAdd
                onSubmit={async (title) => (onCreateTask ? (await onCreateTask(title)) !== null : false)}
                disabled={!onCreateTask}
                failureMessage="Could not create the task. Your draft has been kept. Try again."
              />
            </div>
          ) : null}
          {view === "list" ? (
            <section aria-label="List view" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <WorkListView agents={agents} tasks={tasks} selectedId={selected?.id} onOpen={onTaskChange} onToggleDone={toggleDone} />
            </section>
          ) : view === "board" ? (
            <section aria-label="Board view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <WorkBoardView
                agents={agents}
                tasks={tasks}
                onOpen={onTaskChange}
                onMove={onUpdateTask ? (id, status) => onUpdateTask(id, { status }) : undefined}
                className="h-full"
              />
            </section>
          ) : view === "timeline" ? (
            <section aria-label="Timeline view" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
              <WorkTimelineView tasks={tasks} onOpen={onTaskChange} className="h-full" />
            </section>
          ) : (
            <section aria-label="Organization view" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <WorkOrganizationView employees={employees} onOpen={onOpenEmployee} user={user} />
            </section>
          )}
      </div>
    </div>
  );

  const closeTask = () => onTaskChange(null);
  const detail = selected
    ? {
        onClose: closeTask,
        panel: (
          <TaskDetailPanel
            task={selected}
            agents={agents}
            tasks={all}
            onChange={(patch) => onUpdateTask?.(selected.id, patch)}
            onComment={onCommentTask ? (text) => onCommentTask(selected.id, text) : undefined}
            onArchive={() => {
              onArchiveTask?.(selected.id);
              closeTask();
            }}
            onClose={closeTask}
          />
        ),
      }
    : undefined;

  return workShell(
    props,
    {
      needsYou: all.filter(teamWorkNeedsViewer),
      assignedToMe: open.filter((task) => isTeamWorkAssignedToViewer(task, currentActorId) || (!!currentActorId && task.ownerId === currentActorId)),
      everything: open,
      selectedId: selected?.id,
      onOpenTask: onTaskChange,
      onSearch: () => setSearchOpen(true),
    },
    card,
    detail,
  );
}
