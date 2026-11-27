/** Read-only workspace overview. Actions always navigate to the owning review or work surface. */
import { useMemo, type JSX } from "react";
import {
  Activity,
  ArrowRight,
  Blocks,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  PanelLeft,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
  ERROR_FAMILY_STATUSES,
  formatTimeAgo,
  parseRepoName,
  statusChipClass,
  statusLabel,
} from "../ui-helpers";
import type { AgentPrincipal, RetainedRun, StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import type { AppNavView } from "./AppNavRail";
import { MainCard, EmptyState, type Scope } from "./ui/ContextPanel";
import { AgentAvatar } from "./AgentAvatar";
import type { OrganizationEmployee } from "./WorkOrganizationView";
import { teamWorkNeedsViewer, type TeamWorkItem } from "../team-work-items";

export interface DashboardViewProps {
  runs: RetainedRun[];
  pendingApprovals: PendingApproval[];
  storedApprovals: StoredApproval[];
  agents: AgentPrincipal[];
  connectionLabel: string;
  connectionTone: "ok" | "pending" | "error";
  launchBlocked?: boolean;
  runsError: string | null;
  onNavigate: (view: AppNavView) => void;
  onNewTask: () => void;
  onInspectRun: (runId: string) => void;
  employees?: readonly OrganizationEmployee[];
  workspaceId?: string;
  workspaceName?: string;
  currentActorId?: string;
  sharedTasks?: readonly TeamWorkItem[];
  sharedTasksLoading?: boolean;
  onOpenEmployee?: (employeeId: string) => void;
  onOpenSharedTask?: (task: TeamWorkItem) => void;
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const TONE_DOT = {
  ok: "bg-[var(--success)]",
  pending: "bg-[var(--warning-fg)]",
  error: "bg-[var(--destructive)]",
};

export function DashboardView({
  runs,
  pendingApprovals,
  storedApprovals,
  agents,
  connectionLabel,
  connectionTone,
  launchBlocked = false,
  runsError,
  onNavigate,
  onNewTask,
  onInspectRun,
  employees = [],
  workspaceId,
  workspaceName,
  currentActorId,
  sharedTasks = [],
  sharedTasksLoading = false,
  onOpenEmployee,
  onOpenSharedTask,
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
}: DashboardViewProps): JSX.Element {
  const approvalCount = pendingApprovals.length + storedApprovals.length;
  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";
  const stats = useMemo(() => {
    const active = runs.filter((run) => run.status === "running" || run.status === "pending");
    const completedRuns = runs.filter((run) => run.status === "completed");
    const errors = runs.filter((run) => ERROR_FAMILY_STATUSES.has(run.status)).length;
    const terminal = completedRuns.length + errors;
    const durations = completedRuns
      .map((run) => run.updatedAt - run.createdAt)
      .filter((duration) => duration > 0)
      .sort((a, b) => a - b);
    return {
      active,
      errors,
      completed: completedRuns.length,
      successRate: terminal > 0 ? Math.round((completedRuns.length / terminal) * 100) : null,
      medianMs: durations[Math.floor(durations.length / 2)] ?? null,
      prRequested: runs.filter((run) => run.publishPullRequest).length,
    };
  }, [runs]);
  const recentRuns = useMemo(
    () =>
      [...runs]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .slice(0, 6),
    [runs],
  );
  const liveAgents = agents.filter((agent) => agent.live).length;
  const openSharedTasks = useMemo(
    () => sharedTasks.filter((task) => !task.archived && !["done", "completed", "cancelled"].includes(task.status)),
    [sharedTasks],
  );
  const employeeRows = useMemo(() => employees.map((employee) => {
    const actorId = `agent:${employee.id}`;
    const assigned = openSharedTasks.filter((task) => task.assigneeActorId === actorId || task.assigneeName === employee.name);
    const activeRuns = runs.filter((run) => run.customAgentId === employee.id && ["running", "pending", "queued"].includes(run.status)).length;
    const needsViewer = assigned.filter(teamWorkNeedsViewer).length;
    const working = assigned.filter((task) => ["in-progress", "running", "queued"].includes(task.status)).length + activeRuns;
    return { employee, assigned, needsViewer, working, status: working ? "working" as const : needsViewer ? "needs-approval" as const : "idle" as const };
  }), [employees, openSharedTasks, runs]);
  const workingEmployeeCount = employeeRows.filter((row) => row.working > 0).length;
  const visibleSharedTasks = openSharedTasks.slice(0, 6);
  const nextStep =
    approvalCount > 0
      ? {
          label: "Your review comes first",
          detail: `${approvalCount} request${approvalCount === 1 ? " is" : "s are"} waiting for your decision. Review the details before any approved action runs.`,
          action: "Review approvals",
          view: "approvals" as const,
          icon: ShieldCheck,
        }
      : launchBlocked
        ? {
            label: "Connect a provider to get started",
            detail: "Choose your coding provider, then return here to delegate your first task.",
            action: "Open providers",
            view: "providers" as const,
            icon: Terminal,
          }
        : {
            label: stats.active.length > 0 ? "Work is in motion" : "Make room for your next idea",
            detail:
              stats.active.length > 0
                ? `${stats.active.length} run${stats.active.length === 1 ? " is" : "s are"} running or pending. Open Work to follow progress and next steps.`
                : "Plan a task, choose an agent, and review the request before execution starts.",
            action: "Open work",
            view: "work" as const,
            icon: Activity,
          };
  const NextIcon = nextStep.icon;
  const teamSafeView = (view: AppNavView): AppNavView => {
    if (!workspaceId) return view;
    if (view === "analytics") return "work";
    if (view === "approvals") return "threads";
    if (view === "memory") return "skills";
    if (view === "agents") return "custom-agents";
    return view;
  };

  return (
    <MainCard className={`shiba-dashboard ${className}`}>
      <header className="shiba-dashboard-toolbar">
        <div className="flex min-w-0 items-center gap-2">
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              className="shiba-overview-icon-button hidden lg:flex"
            >
              <PanelLeft className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground-2)]">
              <li>{scopeLabel}</li>
              <li aria-hidden="true">
                <ChevronRight className="size-3.5" />
              </li>
              <li>Insights</li>
            </ol>
          </nav>
        </div>
        <span className="shiba-connection-status" title={connectionLabel}>
          <span
            className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[connectionTone]}`}
            aria-hidden="true"
          />
          <span className="truncate">{connectionLabel}</span>
        </span>
      </header>
      <div className="shiba-dashboard-scroll">
        <div className="shiba-dashboard-body">
          <section className="shiba-dashboard-heading" aria-labelledby="dashboard-title">
            <div className="min-w-0">
              <p className="shiba-overview-eyebrow">{scope === "workspace" ? "Employee workspace" : "Workspace overview"}</p>
              <h1 id="dashboard-title">Dashboard</h1>
              <p className="shiba-overview-description">
                Your work, decisions, and agents. One place to see what happens next.
              </p>
            </div>
            <button
              type="button"
              onClick={onNewTask}
              aria-label="New task"
              className="shiba-overview-primary"
            >
              <Plus className="size-4" aria-hidden="true" />
              New task
            </button>
          </section>

          {launchBlocked ? (
            <div data-testid="launch-blocked-banner" className="shiba-overview-notice">
              <Terminal className="size-4 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1">
                Can&apos;t launch yet: connect a provider. Open Providers and finish Codex or Claude
                sign-in, or set AI_GATEWAY_TOKEN.
              </p>
              <button
                type="button"
                onClick={() => onNavigate("providers")}
                className="shiba-overview-link"
              >
                Open providers <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {runsError ? (
            <p
              role="alert"
              className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive-soft)] px-4 py-3 text-sm text-[var(--destructive-fg)]"
            >
              Run history is unavailable: {runsError}
            </p>
          ) : null}

          <section className="shiba-overview-next" aria-labelledby="dashboard-next-title">
            <span className="shiba-overview-next-icon">
              <NextIcon className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="dashboard-next-title">{nextStep.label}</h2>
              <p>{nextStep.detail}</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate(teamSafeView(nextStep.view))}
              className="shiba-overview-secondary"
            >
              {nextStep.action}
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </section>

          <section aria-label="Run summary" className="shiba-overview-stats">
            {(
              [
                {
                  label: "Total runs",
                  value: runs.length,
                  detail: `${stats.prRequested} requested a PR`,
                  icon: Activity,
                  view: "analytics",
                },
                {
                  label: "Active sandboxes",
                  value: stats.active.length,
                  detail: stats.active.length ? "Running or pending now" : "Nothing in flight",
                  icon: Terminal,
                  view: "tasks",
                },
                {
                  label: "Pending approvals",
                  value: approvalCount,
                  detail: approvalCount ? "Ready for your review" : "You’re all caught up",
                  icon: ShieldCheck,
                  view: "approvals",
                },
                {
                  label: "Success rate",
                  value: stats.successRate === null ? "—" : `${stats.successRate}%`,
                  detail:
                    stats.medianMs === null
                      ? "No completed runs yet"
                      : `${formatDuration(stats.medianMs)} median cycle`,
                  icon: CircleCheck,
                  view: "analytics",
                },
              ] as const
            ).map((metric) => (
              <button
                type="button"
                key={metric.label}
                className="shiba-overview-stat"
                onClick={() => onNavigate(teamSafeView(metric.view))}
              >
                <span className="flex items-center justify-between gap-2">
                  <span>{metric.label}</span>
                  <metric.icon className="size-4 text-[var(--icon-muted)]" aria-hidden="true" />
                </span>
                <strong>{runsError && metric.view !== "approvals" ? "—" : metric.value}</strong>
                <span className="shiba-overview-stat-detail">
                  {runsError && metric.view !== "approvals"
                    ? "Run history unavailable"
                    : metric.detail}
                </span>
              </button>
            ))}
          </section>


          {workspaceId ? (
            <section className="shiba-overview-panel" aria-labelledby="dashboard-work-title">
              <header className="shiba-overview-section-header">
                <div>
                  <h2 id="dashboard-work-title">Shared work queue</h2>
                  <p>{workspaceName ? `${workspaceName} · ` : ""}{openSharedTasks.length} open item{openSharedTasks.length === 1 ? "" : "s"} across the employee workspace</p>
                </div>
                <button type="button" onClick={() => onNavigate("work")} className="shiba-overview-link">
                  Open work <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </header>
              {sharedTasksLoading ? (
                <p className="px-5 py-4 text-sm text-[var(--muted-foreground-2)]">Loading shared work…</p>
              ) : visibleSharedTasks.length === 0 ? (
                <div className="flex items-center gap-3 p-5 text-sm">
                  <span className="shiba-overview-clear-icon"><Check className="size-4" aria-hidden="true" /></span>
                  <span>No shared work is waiting.<span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">Assign work to an employee and it will appear here.</span></span>
                </div>
              ) : (
                <ul className="shiba-overview-run-list">
                  {visibleSharedTasks.map((task) => (
                    <li key={task.id}>
                      <button type="button" onClick={() => onOpenSharedTask ? onOpenSharedTask(task) : onNavigate("work")} className="shiba-overview-run">
                        <span className="shiba-overview-run-icon"><Activity className="size-4" aria-hidden="true" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium" title={task.title}>{task.title}</span>
                          <span className="mt-1 block truncate text-xs text-[var(--muted-foreground-2)]">
                            {task.assigneeName ?? (task.assigneeKind === "agent" ? "Employee" : "Member")} · {task.roomTitle || "Workspace"}
                          </span>
                        </span>
                        <span className="shiba-overview-run-meta">
                          <span className={`rounded border px-2 py-0.5 text-[10px] font-medium ${statusChipClass(task.status)}`}>{statusLabel(task.status)}</span>
                          <span className="text-[11px] text-[var(--muted-foreground-2)]">{formatTimeAgo(task.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <footer className="shiba-overview-panel-footer">
                <span>{visibleSharedTasks.length} shown</span>
                <span>{openSharedTasks.filter(teamWorkNeedsViewer).length} need review</span>
              </footer>
            </section>
          ) : null}

          <div className={`shiba-overview-columns${scope === "workspace" ? " shiba-overview-columns-workspace" : ""}`}>
            {scope !== "workspace" ? (
            <section className="shiba-overview-panel" aria-labelledby="dashboard-recent-title">
              <header className="shiba-overview-section-header">
                <div>
                  <h2 id="dashboard-recent-title">Recent activity</h2>
                  <p>The latest updates from your runs</p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate("analytics")}
                  className="shiba-overview-link"
                >
                  View all <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </header>
              {recentRuns.length === 0 ? (
                <div className="shiba-overview-empty">
                  <EmptyState
                    icon={Clock3}
                    title={runsError ? "Run history unavailable" : "No runs yet"}
                    description={
                      runsError
                        ? "Your saved runs will appear when the connection recovers."
                        : "Your first task starts a history of progress here."
                    }
                    action={
                      <button type="button" onClick={onNewTask} className="shiba-overview-link">
                        Delegate your first task{" "}
                        <ArrowRight className="size-3.5" aria-hidden="true" />
                      </button>
                    }
                  />
                </div>
              ) : (
                <ul className="shiba-overview-run-list">
                  {recentRuns.map((run) => (
                    <li key={run.runId}>
                      <button
                        type="button"
                        onClick={() => onInspectRun(run.runId)}
                        className="shiba-overview-run"
                      >
                        <span className="shiba-overview-run-icon">
                          <Terminal className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate font-medium"
                            title={run.task || "Untitled run"}
                          >
                            {run.task || "Untitled run"}
                          </span>
                          <span className="mt-1 block truncate text-xs text-[var(--muted-foreground-2)]">
                            {parseRepoName(run.repoUrl)} · {run.baseBranch}
                          </span>
                        </span>
                        <span className="shiba-overview-run-meta">
                          <span
                            className={`rounded border px-2 py-0.5 text-[10px] font-medium ${statusChipClass(run.status)}`}
                          >
                            {statusLabel(run.status)}
                          </span>
                          <span className="text-[11px] text-[var(--muted-foreground-2)]">
                            {formatTimeAgo(run.updatedAt || run.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <footer className="shiba-overview-panel-footer">
                <span>{recentRuns.length} shown</span>
                <span>
                  {stats.active.length} in flight · {stats.errors} errors
                </span>
              </footer>
            </section>
            ) : null}

            <div className="flex min-w-0 flex-col gap-4">
              <section className="shiba-overview-panel" aria-labelledby="dashboard-approvals-title">
                <header className="shiba-overview-section-header">
                  <div>
                    <h2 id="dashboard-approvals-title">Needs your review</h2>
                    <p>Approval stays in your hands</p>
                  </div>
                  <ShieldCheck
                    className="size-4 shrink-0 text-[var(--icon-muted)]"
                    aria-hidden="true"
                  />
                </header>
                {approvalCount === 0 ? (
                  <div className="flex items-center gap-3 p-5 text-sm">
                    <span className="shiba-overview-clear-icon">
                      <Check className="size-4" aria-hidden="true" />
                    </span>
                    <span>
                      Nothing waiting on you.
                      <span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">
                        New requests will appear here.
                      </span>
                    </span>
                  </div>
                ) : (
                  <>
                    <ul className="shiba-overview-approval-list">
                      {pendingApprovals.slice(0, 3).map((approval) => (
                        <li key={approval.approvalId}>
                          <span className="block truncate font-medium">{approval.tool}</span>
                          <span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">
                            Chat session · pending review
                          </span>
                        </li>
                      ))}
                      {storedApprovals
                        .slice(0, Math.max(0, 3 - pendingApprovals.length))
                        .map((approval) => (
                          <li key={approval.approvalId}>
                            <span className="block truncate font-medium">{approval.task}</span>
                            <span className="mt-1 block truncate text-xs text-[var(--muted-foreground-2)]">
                              {parseRepoName(approval.repoUrl)} · {approval.kind ?? "run"}
                            </span>
                          </li>
                        ))}
                    </ul>
                    <div className="shiba-overview-panel-footer">
                      <span>{approvalCount} pending</span>
                      <button
                        type="button"
                        onClick={() => onNavigate("approvals")}
                        className="shiba-overview-link"
                      >
                        Review all <ArrowRight className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </section>
              <section className="shiba-overview-panel" aria-labelledby="dashboard-agents-title">
                <header className="shiba-overview-section-header">
                  <div>
                    <h2 id="dashboard-agents-title">AI employees</h2>
                    <p>
                      {employees.length ? `${workingEmployeeCount}/${employees.length} working · your employee roster` : `${liveAgents}/${agents.length} MCP principals live`}
                    </p>
                  </div>
                </header>
                {employees.length === 0 ? (
                  <div className="flex items-center gap-3 p-5 text-sm">
                    <span className="shiba-overview-clear-icon"><Plus className="size-4" aria-hidden="true" /></span>
                    <span>No employees yet.<span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">Create one from a role, then assign work from the queue.</span></span>
                  </div>
                ) : (
                  <ul className="shiba-overview-agent-list">
                    {employeeRows.slice(0, 5).map(({ employee, assigned, needsViewer, working, status }) => (
                      <li key={employee.id}>
                        <button type="button" onClick={() => onOpenEmployee ? onOpenEmployee(employee.id) : onNavigate("custom-agents")} className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left">
                          <AgentAvatar id={employee.id} name={employee.name} size={30} status={status} mascotPreset={employee.config?.mascotPreset} look={employee.config?.look} avatar={employee.config ? null : undefined} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{employee.name}</span>
                            <span className="block truncate text-[11px] text-[var(--muted-foreground-2)]">{employee.role}</span>
                          </span>
                          <span className="text-right text-[11px] text-[var(--muted-foreground-2)]">
                            {working ? `${working} working` : needsViewer ? `${needsViewer} review` : `${assigned.length} open`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="shiba-overview-panel-footer">
                  <span>{employees.length ? `${employees.length} in roster` : `${agents.length} principals`}</span>
                  {scope === "workspace" ? (
                    <button type="button" onClick={() => onNavigate("team")} className="shiba-overview-link">
                      Manage people <ArrowRight className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onNavigate("custom-agents")}
                    className="shiba-overview-link"
                  >
                    {employees.length ? "Open roster" : "Create employee"} <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </section>
            </div>
          </div>

          <section aria-labelledby="dashboard-shortcuts-title">
            <div className="mb-3">
              <h2 id="dashboard-shortcuts-title" className="text-sm font-semibold">
                Build your workspace
              </h2>
              <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">
                Tools and context for your next task
              </p>
            </div>
            <div className="shiba-overview-shortcuts">
              {(
                [
                  {
                    id: "integrations",
                    title: "Connect your tools",
                    detail: "Browse apps and account connections",
                    icon: Blocks,
                  },
                  {
                    id: "memory",
                    title: "Add useful context",
                    detail: "Manage memory and source documents",
                    icon: BookOpen,
                  },
                  {
                    id: "custom-agents",
                    title: "Meet your agents",
                    detail: "Instructions, defaults, and tool access",
                    icon: Terminal,
                  },
                ] as const
              ).map((shortcut) => (
                <button
                  type="button"
                  key={shortcut.id}
                  onClick={() => onNavigate(teamSafeView(shortcut.id))}
                  className="shiba-overview-shortcut"
                >
                  <shortcut.icon
                    className="size-4 shrink-0 text-[var(--icon-muted)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{shortcut.title}</span>
                    <span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">
                      {shortcut.detail}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0 text-[var(--icon-muted)]"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </MainCard>
  );
}
