import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { Clock, LayoutGrid, List, Plus, Search, X } from "lucide-react";
import type { RetainedRun, StoredApproval } from "../types";
import { formatTimeAgo, parseRepoName, statusLabel, type PendingApproval as ChatPendingApproval } from "../ui-helpers";
import type { SessionItem } from "./SessionsSidebar";
import { ViewGroup, ViewHeader, viewButtonClass } from "./ui/ViewChrome";

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
}
const STATUS_GROUPS = [
  { id: "needs-approval", name: "Needs approval", dotClass: "bg-[var(--warning)]" },
  { id: "running", name: "Running", dotClass: "bg-[var(--primary)] animate-pulse-subtle" },
  { id: "pr-open", name: "PR open", dotClass: "bg-[var(--success)]" },
  { id: "attention", name: "Needs attention", dotClass: "bg-[var(--destructive)]" },
  { id: "done", name: "Done", dotClass: "bg-[var(--muted-foreground-3)]" },
] as const;

export function WorkView({ runs = [], sessions = [], storedApprovals = [], pendingApprovals = [], onSelectTask, onNewTask, onQuickAddTask, onReviewApproval }: WorkViewProps): JSX.Element {
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
