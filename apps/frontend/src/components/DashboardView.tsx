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
  Users,
} from "lucide-react";
import {
  ERROR_FAMILY_STATUSES,
  formatTimeAgo,
  parseRepoName,
  statusChipClass,
  statusLabel,
} from "../ui-helpers";
import type { TeamWorkItem } from "../team-work-items";
import type { AgentPrincipal, RetainedRun, StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import type { AppNavView } from "./AppNavRail";
import type { OrganizationEmployee } from "./WorkOrganizationView";
import { MainCard, EmptyState, type Scope } from "./ui/ContextPanel";

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
  employees?: OrganizationEmployee[];
  workspaceName?: string;
  sharedTasks?: TeamWorkItem[];
  sharedTasksLoading?: boolean;
  onOpenSharedTask?: (taskId: string) => void;
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
  workspaceName,
  sharedTasks = [],
  sharedTasksLoading = false,
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
  const activeEmployeeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of stats.active) {
      if (run.customAgentId) ids.add(run.customAgentId);
    }
    for (const task of sharedTasks) {
      if (!["running", "in-progress"].includes(task.status)) continue;
      const actorId = task.assigneeActorId ?? task.ownerId;
      if (task.assigneeKind === "agent" && actorId) ids.add(actorId.startsWith("agent:") ? actorId.slice("agent:".length) : actorId);
    }
    return ids;
  }, [stats.active, sharedTasks]);
  const workingEmployees = employees.filter((employee) => activeEmployeeIds.has(employee.id)).length;
  const title = scope === "workspace" ? workspaceName?.trim() || "Workspace" : "Dashboard";
  const workspaceActiveTasks = sharedTasks.filter((task) => ["queued", "running", "in-progress", "needs-approval"].includes(task.status)).length;
  const workspaceReviewTasks = sharedTasks.filter((task) => task.status === "needs-approval" && task.approvalRequired === true);
  const workspaceApprovalTasks = workspaceReviewTasks.length;
  const workspaceCompletedTasks = sharedTasks.filter((task) => task.status === "done" || task.status === "completed").length;
  const workspaceTerminalTasks = sharedTasks.filter((task) => ["done", "completed", "blocked", "cancelled"].includes(task.status)).length;
  const workspaceSuccessRate = workspaceTerminalTasks > 0 ? Math.round((workspaceCompletedTasks / workspaceTerminalTasks) * 100) : null;
  const effectiveApprovalCount = approvalCount + workspaceApprovalTasks;
  const reviewView: AppNavView = scope === "workspace" ? "work" : "approvals";
  const metricCards = scope === "workspace" ? ([
    {
      label: "Shared tasks",
      value: sharedTasks.length,
      detail: `${workspaceActiveTasks} active in this workspace`,
      icon: Activity,
      view: "work",
    },
    {
      label: "AI employees",
      value: employees.length,
      detail: `${workingEmployees} assigned to active runs`,
      icon: Terminal,
      view: "custom-agents",
    },
    {
      label: "Pending approvals",
      value: effectiveApprovalCount,
      detail: effectiveApprovalCount ? "Ready for your review" : "You’re all caught up",
      icon: ShieldCheck,
      view: "work",
    },
    {
      label: "Completion rate",
      value: workspaceSuccessRate === null ? "—" : `${workspaceSuccessRate}%`,
      detail: workspaceTerminalTasks ? `${workspaceCompletedTasks}/${workspaceTerminalTasks} finished` : "No finished shared tasks yet",
      icon: CircleCheck,
      view: "work",
    },
  ] as const) : ([
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
  ] as const);
  const nextStep =
    effectiveApprovalCount > 0
      ? {
          label: "Your review comes first",
          detail: `${effectiveApprovalCount} request${effectiveApprovalCount === 1 ? " is" : "s are"} waiting for your decision. Review the details before any approved action runs.`,
          action: "Review approvals",
          view: reviewView,
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
              <p className="shiba-overview-eyebrow">Workspace overview</p>
              <h1 id="dashboard-title">{title}</h1>
              <p className="shiba-overview-description">
                Your AI employees, their work, and the decisions waiting on you. One place to see what happens next.
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

          <section aria-label="Run summary" className="shiba-overview-stats">
            {metricCards.map((metric) => (
              <button
                type="button"
                key={metric.label}
                className="shiba-overview-stat"
                onClick={() => onNavigate(metric.view)}
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
              onClick={() => onNavigate(nextStep.view)}
              className="shiba-overview-secondary"
            >
              {nextStep.action}
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </section>

          {scope === "workspace" ? (
            <section className="shiba-overview-panel mb-4" aria-labelledby="dashboard-shared-work-title">
              <header className="shiba-overview-section-header">
                <div>
                  <h2 id="dashboard-shared-work-title">Shared work queue</h2>
                  <p>Tasks owned by people and AI employees in this workspace</p>
                </div>
                <button type="button" onClick={() => onNavigate("work")} className="shiba-overview-link">
                  Open work <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </header>
              {sharedTasksLoading ? (
                <p className="px-5 py-4 text-sm text-[var(--muted-foreground-2)]">Loading shared work…</p>
              ) : sharedTasks.length === 0 ? (
                <div className="px-5 py-4 text-sm text-[var(--muted-foreground-2)]">
                  <p>No shared tasks yet. Create one in Work and assign it to a person or employee.</p>
                  <button type="button" onClick={() => onNavigate("work")} className="shiba-overview-link mt-3">
                    Create shared work <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <ul className="shiba-overview-run-list">
                  {sharedTasks.slice(0, 4).map((task) => (
                    <li key={task.id}>
                      <button type="button" onClick={() => onOpenSharedTask ? onOpenSharedTask(task.id) : onNavigate("work")} className="shiba-overview-run">
                        <span className="shiba-overview-run-icon">
                          <Activity className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium" title={task.title}>{task.title}</span>
                          <span className="mt-1 block truncate text-xs text-[var(--muted-foreground-2)]">
                            {task.assigneeName || (task.assigneeKind === "agent" ? "AI employee" : "Unassigned")} · {task.roomTitle}
                          </span>
                        </span>
                        <span className="shiba-overview-run-meta">
                          <span className="rounded border border-[var(--border-1)] px-2 py-0.5 text-[10px] font-medium">
                            {task.status.replaceAll("-", " ")}
                          </span>
                          <span className="text-[11px] text-[var(--muted-foreground-2)]">{formatTimeAgo(task.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <footer className="shiba-overview-panel-footer">
                <span>{sharedTasks.length} shared task{sharedTasks.length === 1 ? "" : "s"}</span>
                <span>{sharedTasks.filter((task) => task.status === "needs-approval").length} need approval</span>
              </footer>
            </section>
          ) : null}

          <div className="shiba-overview-columns">
            {scope === "personal" ? (
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
                {effectiveApprovalCount === 0 ? (
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
                      {scope === "workspace"
                        ? workspaceReviewTasks.slice(0, 3).map((task) => (
                            <li key={task.id}>
                              <span className="block truncate font-medium">{task.title}</span>
                              <span className="mt-1 block truncate text-xs text-[var(--muted-foreground-2)]">
                                {task.assigneeName || (task.assigneeKind === "agent" ? "AI employee" : "Workspace member")} · {task.roomTitle}
                              </span>
                            </li>
                          ))
                        : null}
                      {scope === "workspace" ? null : pendingApprovals.slice(0, 3).map((approval) => (
                        <li key={approval.approvalId}>
                          <span className="block truncate font-medium">{approval.tool}</span>
                          <span className="mt-1 block text-xs text-[var(--muted-foreground-2)]">
                            Chat session · pending review
                          </span>
                        </li>
                      ))}
                      {scope === "workspace" ? null : storedApprovals
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
                      <span>{effectiveApprovalCount} pending</span>
                      <button
                        type="button"
                        onClick={() => onNavigate(reviewView)}
                        className="shiba-overview-link"
                      >
                        Review all <ArrowRight className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </section>
              <section className="shiba-overview-panel" aria-labelledby="dashboard-employees-title">
                <header className="shiba-overview-section-header">
                  <div>
                    <h2 id="dashboard-employees-title">AI employees</h2>
                    <p>
                      {employees.length === 0
                        ? "Build your workspace roster"
                        : `${workingEmployees}/${employees.length} assigned to active runs`}
                    </p>
                  </div>
                </header>
                {employees.length === 0 ? (
                  <div className="px-5 py-4 text-sm text-[var(--muted-foreground-2)]">
                    <p>No employees hired yet. Create a persistent role, then delegate approved work to it.</p>
                    <button
                      type="button"
                      onClick={() => onNavigate("custom-agents")}
                      className="shiba-overview-link mt-3"
                    >
                      Hire your first employee <ArrowRight className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <ul className="shiba-overview-agent-list">
                    {employees.slice(0, 4).map((employee) => {
                      const active = activeEmployeeIds.has(employee.id);
                      return (
                        <li key={employee.id}>
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border-1)] text-sm" aria-hidden="true">
                            {employee.emoji || employee.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{employee.name}</span>
                            <span className="block truncate text-xs text-[var(--muted-foreground-2)]">{employee.role}</span>
                          </span>
                          <span className={`rounded border px-2 py-0.5 text-[10px] font-medium ${active ? "border-[var(--success)] text-[var(--success-fg)]" : "border-[var(--border-1)] text-[var(--muted-foreground-2)]"}`}>
                            {active ? "working" : "ready"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="shiba-overview-panel-footer">
                  <span>{employees.length} in roster</span>
                  <button
                    type="button"
                    onClick={() => onNavigate("custom-agents")}
                    className="shiba-overview-link"
                  >
                    Manage roster <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </section>

              {scope === "personal" ? (
              <section className="shiba-overview-panel" aria-labelledby="dashboard-agents-title">
                <header className="shiba-overview-section-header">
                  <div>
                    <h2 id="dashboard-agents-title">MCP principals</h2>
                    <p>
                      {liveAgents}/{agents.length} live · registered gateway identities
                    </p>
                  </div>
                </header>
                {agents.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-[var(--muted-foreground-2)]">
                    No MCP principals registered yet.
                  </p>
                ) : (
                  <ul className="shiba-overview-agent-list">
                    {agents.slice(0, 4).map((agent) => (
                      <li key={agent.principal}>
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${agent.live ? "bg-[var(--success)]" : "bg-[var(--muted-foreground-3)]"}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{agent.principal}</span>
                        <span className="text-xs text-[var(--muted-foreground-2)]">
                          {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="shiba-overview-panel-footer">
                  <button
                    type="button"
                    onClick={() => onNavigate("agents")}
                    className="shiba-overview-link"
                  >
                    Manage MCP <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </section>
              ) : null}
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
                    id: scope === "workspace" ? "team" : "memory",
                    title: scope === "workspace" ? "Manage people" : "Add useful context",
                    detail: scope === "workspace" ? "Members, invitations, and workspace roles" : "Manage memory and source documents",
                    icon: scope === "workspace" ? Users : BookOpen,
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
                  onClick={() => onNavigate(shortcut.id)}
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
