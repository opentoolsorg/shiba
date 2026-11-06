/**
 * DashboardView — the "Dashboard" home in Insights hub.
 * Main card: 48px header with breadcrumb "Scope > Insights > Dashboard",
 * neutral stat cards, capability cards, recent activity, and approvals queue.
 * Purely presentational — all data flows in from app.tsx; actions navigate to owning views.
 */
import { useMemo, type JSX } from "react";
import { Check, ChevronRight, PanelLeft, Plus } from "lucide-react";
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
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const TONE_DOT: Record<"ok" | "pending" | "error", string> = {
  ok: "bg-emerald-500",
  pending: "bg-amber-500",
  error: "bg-rose-500",
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
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
}: DashboardViewProps): JSX.Element {
  const approvalCount = pendingApprovals.length + storedApprovals.length;
  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";

  const stats = useMemo(() => {
    const active = runs.filter((r) => r.status === "running" || r.status === "pending");
    const completedRuns = runs.filter((r) => r.status === "completed");
    const errors = runs.filter((r) => ERROR_FAMILY_STATUSES.has(r.status)).length;
    const terminal = completedRuns.length + errors;
    const successRate = terminal > 0 ? Math.round((completedRuns.length / terminal) * 100) : null;
    const durations = completedRuns
      .map((r) => r.updatedAt - r.createdAt)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null;
    const prRequested = runs.filter((r) => r.publishPullRequest).length;
    return { active, completed: completedRuns.length, errors, successRate, medianMs, prRequested };
  }, [runs]);

  const recentRuns = useMemo(
    () => [...runs].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, 8),
    [runs],
  );

  const liveAgents = agents.filter((a) => a.live).length;

  return (
    <MainCard className={className}>
      {/* 48px Header */}
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              className="flex size-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              <li className="flex items-center gap-1.5 min-w-0">
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">{scopeLabel}</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">Insights</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <h1 className="text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate" aria-current="page">
                  Dashboard
                </h1>
              </li>
            </ol>
            <span className="ml-2 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.1em] font-normal text-[#71717a] dark:text-zinc-400">
              <span className={`size-1.5 rounded-full ${TONE_DOT[connectionTone]}`} aria-hidden="true" />
              {connectionLabel}
            </span>
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onNewTask}
            aria-label="New task"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[#e4e4e7] px-2.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#d4d4d8] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
            <span>New Task</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain p-4 lg:p-6 flex flex-col gap-6 text-[#0a0a0a] dark:text-zinc-100">
        {launchBlocked ? (
          <p
            data-testid="launch-blocked-banner"
            className="rounded-lg border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            Can&apos;t launch yet: connect a provider. Open Providers and finish Codex or Claude sign-in, or set AI_GATEWAY_TOKEN.
          </p>
        ) : null}

        {runsError ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
          >
            Run history is unavailable: {runsError}
          </p>
        ) : null}

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <button
            type="button"
            onClick={() => onNavigate("analytics")}
            className="relative flex flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 text-left transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
          >
            <span className="absolute top-3 right-3 text-[10px] font-mono text-[#a1a1aa] dark:text-zinc-500">01</span>
            <span className="text-[11px] font-medium text-[#71717a] dark:text-zinc-400 uppercase tracking-wider">
              Total runs
            </span>
            <span className="mt-2 text-2xl font-semibold tabular-nums text-[#0a0a0a] dark:text-zinc-100">{runs.length}</span>
            <span className="mt-1 text-[12px] text-[#71717a] dark:text-zinc-400">
              {stats.prRequested} requested a PR
            </span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("tasks")}
            className="relative flex flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 text-left transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
          >
            <span className="absolute top-3 right-3 text-[10px] font-mono text-[#a1a1aa] dark:text-zinc-500">02</span>
            <span className="text-[11px] font-medium text-[#71717a] dark:text-zinc-400 uppercase tracking-wider">
              Active sandboxes
            </span>
            <span className="mt-2 text-2xl font-semibold tabular-nums text-[#0a0a0a] dark:text-zinc-100">
              {stats.active.length}
            </span>
            <span className="mt-1 text-[12px] text-[#71717a] dark:text-zinc-400">
              {stats.active.length > 0 ? "running or pending now" : "nothing in flight"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("approvals")}
            className="relative flex flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 text-left transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
          >
            <span className="absolute top-3 right-3 text-[10px] font-mono text-[#a1a1aa] dark:text-zinc-500">03</span>
            <span className="text-[11px] font-medium text-[#71717a] dark:text-zinc-400 uppercase tracking-wider">
              Pending approvals
            </span>
            <span className={`mt-2 text-2xl font-semibold tabular-nums ${approvalCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-[#0a0a0a] dark:text-zinc-100"}`}>
              {approvalCount}
            </span>
            <span className="mt-1 text-[12px] text-[#71717a] dark:text-zinc-400">
              {approvalCount > 0 ? "waiting on your decision" : "queue is clear"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("analytics")}
            className="relative flex flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 text-left transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
          >
            <span className="absolute top-3 right-3 text-[10px] font-mono text-[#a1a1aa] dark:text-zinc-500">04</span>
            <span className="text-[11px] font-medium text-[#71717a] dark:text-zinc-400 uppercase tracking-wider">
              Success rate
            </span>
            <span className="mt-2 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {stats.successRate !== null ? `${stats.successRate}%` : "—"}
            </span>
            <span className="mt-1 text-[12px] text-[#71717a] dark:text-zinc-400">
              {stats.medianMs !== null ? `median run ${formatDuration(stats.medianMs)}` : "no completed runs yet"}
            </span>
          </button>
        </div>

        {/* Capability plane */}
        <section aria-labelledby="capability-plane-title" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="capability-plane-title" className="text-sm font-semibold tracking-tight text-[#0a0a0a] dark:text-zinc-100">
              Your agent plane
            </h2>
            <span className="text-[11px] text-[#71717a] dark:text-zinc-400 font-mono">
              Account-owned tools
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {([
              { id: "agents", number: "01", title: "Agents & MCP", detail: `${agents.length} registered principal${agents.length === 1 ? "" : "s"} · scopes and gateway` },
              { id: "inbox", number: "02", title: "Mailbox", detail: "Review mail, drafts, and approval-gated sends" },
              { id: "memory", number: "03", title: "Memory", detail: "Recall, browse, and manage stored context" },
              { id: "analytics", number: "04", title: "Sandbox", detail: "Inspect runs, terminals, and changed files" },
            ] as const).map((capability) => (
              <button
                key={capability.id}
                type="button"
                onClick={() => onNavigate(capability.id)}
                className="flex flex-col rounded-xl border border-[#e4e4e7] bg-white p-4 text-left transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
              >
                <span className="text-[10px] font-mono text-[#a1a1aa] dark:text-zinc-500">{capability.number} / CAPABILITY</span>
                <span className="mt-2 text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">{capability.title}</span>
                <span className="mt-1 text-[12px] leading-relaxed text-[#71717a] dark:text-zinc-400">{capability.detail}</span>
                <span className="mt-3 text-[11px] font-medium text-zinc-900 dark:text-zinc-200">Open surface →</span>
              </button>
            ))}
          </div>
        </section>

        {/* Recent activity & approvals */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Recent activity */}
          <section className="lg:col-span-3 rounded-xl border border-[#e4e4e7] bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-900/40">
            <header className="flex items-center justify-between border-b border-[#e4e4e7] px-4 py-3 dark:border-zinc-800">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
                Recent Activity
              </h3>
              <button
                type="button"
                onClick={() => onNavigate("analytics")}
                className="text-[12px] font-medium text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
              >
                View all runs →
              </button>
            </header>
            {recentRuns.length === 0 ? (
              <div className="py-12 text-center">
                <EmptyState
                  title="No runs yet"
                  description="Delegate your first task to see execution history."
                  action={
                    <button
                      type="button"
                      onClick={onNewTask}
                      className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 hover:underline"
                    >
                      Delegate your first task →
                    </button>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-[#e4e4e7] dark:divide-zinc-800">
                {recentRuns.map((run) => (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => onInspectRun(run.runId)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/40 transition-colors text-left"
                    >
                      <span
                        className={`shrink-0 text-[10px] font-bold uppercase tracking-wider border rounded px-2 py-0.5 ${statusChipClass(run.status)}`}
                      >
                        {statusLabel(run.status)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">{run.task}</span>
                        <span className="block text-[11px] font-mono text-[#71717a] dark:text-zinc-400 truncate">
                          {parseRepoName(run.repoUrl)} · {run.baseBranch}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] font-mono text-[#71717a] dark:text-zinc-400">
                        {formatTimeAgo(run.updatedAt || run.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <footer className="flex items-center justify-between border-t border-[#e4e4e7] px-4 py-2 text-[11px] text-[#71717a] dark:border-zinc-800 dark:text-zinc-400">
              <span>{recentRuns.length} shown</span>
              <span>{stats.active.length} in flight</span>
              <span>{stats.errors} errors</span>
            </footer>
          </section>

          {/* Right column: approvals queue + agents */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            <section className="rounded-xl border border-[#e4e4e7] bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-900/40">
              <header className="flex items-center justify-between border-b border-[#e4e4e7] px-4 py-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
                  Approvals queue
                </h3>
                {approvalCount > 0 ? (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/20 dark:text-amber-300 tabular-nums">
                    {approvalCount}
                  </span>
                ) : null}
              </header>
              {approvalCount === 0 ? (
                <div className="px-4 py-6 flex items-center gap-2.5 text-[13px] text-emerald-600 dark:text-emerald-400">
                  <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                  Nothing waiting on you.
                </div>
              ) : (
                <ul className="divide-y divide-[#e4e4e7] dark:divide-zinc-800">
                  {pendingApprovals.slice(0, 4).map((approval) => (
                    <li key={approval.approvalId} className="px-4 py-3">
                      <div className="text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">{approval.tool}</div>
                      <div className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400">chat session</div>
                    </li>
                  ))}
                  {storedApprovals.slice(0, 4).map((approval) => (
                    <li key={approval.approvalId} className="px-4 py-3">
                      <div className="text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">{approval.task}</div>
                      <div className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400 truncate">
                        {parseRepoName(approval.repoUrl)} · {approval.kind ?? "run"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {approvalCount > 0 ? (
                <div className="px-4 py-3 border-t border-[#e4e4e7] dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => onNavigate("approvals")}
                    className="w-full h-8 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs font-semibold transition-colors"
                  >
                    Review Approvals
                  </button>
                </div>
              ) : null}
            </section>

            <section className="rounded-xl border border-[#e4e4e7] bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-900/40">
              <header className="flex items-center justify-between border-b border-[#e4e4e7] px-4 py-3 dark:border-zinc-800">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#71717a] dark:text-zinc-400">
                  Registered Agents
                </h3>
                <span className="text-[11px] font-mono text-[#71717a] dark:text-zinc-400">
                  {liveAgents}/{agents.length} live
                </span>
              </header>
              {agents.length === 0 ? (
                <div className="px-4 py-6 text-[13px] text-[#71717a] dark:text-zinc-400">
                  No MCP principals registered yet.
                </div>
              ) : (
                <ul className="divide-y divide-[#e4e4e7] dark:divide-zinc-800">
                  {agents.slice(0, 5).map((agent) => (
                    <li key={agent.principal} className="px-4 py-2.5 flex items-center gap-2.5">
                      <span
                        className={`size-1.5 rounded-full shrink-0 ${agent.live ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0 text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate">{agent.principal}</span>
                      <span className="shrink-0 text-[10px] font-mono text-[#71717a] dark:text-zinc-400">
                        {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </MainCard>
  );
}
