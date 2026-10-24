/**
 * DashboardView — the "Dashboard" home: an at-a-glance overview of the whole
 * agent plane. Stat cards (runs, success rate, active sandboxes, approvals),
 * a pending-approvals queue, and a recent-activity feed. Purely presentational
 * — all data flows in from app.tsx; actions navigate to the owning view.
 */
import { useMemo, type JSX } from "react";
import { Check, Plus } from "lucide-react";
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
}: DashboardViewProps): JSX.Element {
  const approvalCount = pendingApprovals.length + storedApprovals.length;

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
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain bg-[var(--bg)] text-[var(--fg)]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6">
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold font-sans tracking-tight flex items-center gap-2.5">
              Dashboard
              <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.1em] font-normal text-[var(--muted-foreground-2)]">
                <span className={`size-1.5 rounded-full ${TONE_DOT[connectionTone]}`} aria-hidden="true" />
                {connectionLabel}
              </span>
            </h2>
            <p className="text-xs text-[var(--muted-foreground-2)] mt-0.5">
              Everything your agent plane is doing, at a glance.
            </p>
            {launchBlocked ? (
              <p
                data-testid="launch-blocked-banner"
                className="mt-2 border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--fg)]"
              >
                Can't launch yet: connect a provider. Open Providers and finish Codex or Claude sign-in, or set AI_GATEWAY_TOKEN.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onNewTask}
            className="bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[color-mix(in_oklch,var(--primary)_88%,black)] min-h-11 rounded-[var(--radius-button)] text-[13px] font-semibold px-4 flex items-center gap-2"
          >
            <Plus aria-hidden="true" className="size-4" strokeWidth={2} />
            New Task
          </button>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 paper-dots p-2 -m-2">
          <button
            type="button"
            onClick={() => onNavigate("analytics")}
            className="relative text-left bg-[var(--card)] border border-[var(--border-2)] rounded-[var(--radius-button)] p-4 hover:border-[var(--primary)]/30 hover:shadow-[var(--sh-card)] transition-all group"
          >
            <span className="absolute top-2 right-2 text-[10px] font-mono text-[var(--muted-foreground-3)]">01</span>
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Total runs
            </div>
            <div className="mt-1.5 text-xl font-bold font-sans tabular-nums">{runs.length}</div>
            <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">
              {stats.prRequested} requested a PR
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("tasks")}
            className="relative text-left bg-[var(--card)] border border-[var(--border-2)] rounded-[var(--radius-button)] p-4 hover:border-[var(--primary)]/30 hover:shadow-[var(--sh-card)] transition-all"
          >
            <span className="absolute top-2 right-2 text-[10px] font-mono text-[var(--muted-foreground-3)]">02</span>
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Active sandboxes
            </div>
            <div className="mt-1.5 text-xl font-bold font-sans tabular-nums text-[var(--primary)]">
              {stats.active.length}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">
              {stats.active.length > 0 ? "running or pending now" : "nothing in flight"}
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("approvals")}
            className="relative text-left bg-[var(--card)] border border-[var(--border-2)] rounded-[var(--radius-button)] p-4 hover:border-[color-mix(in_oklch,var(--warning)_40%,transparent)] hover:shadow-[var(--sh-card)] transition-all"
          >
            <span className="absolute top-2 right-2 text-[10px] font-mono text-[var(--muted-foreground-3)]">03</span>
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Pending approvals
            </div>
            <div className={`mt-1.5 text-xl font-bold font-sans tabular-nums ${approvalCount > 0 ? "text-[var(--warning-fg)]" : ""}`}>
              {approvalCount}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">
              {approvalCount > 0 ? "waiting on your decision" : "queue is clear"}
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigate("analytics")}
            className="relative text-left bg-[var(--card)] border border-[var(--border-2)] rounded-[var(--radius-button)] p-4 hover:border-[color-mix(in_oklch,var(--success)_30%,transparent)] hover:shadow-[var(--sh-card)] transition-all"
          >
            <span className="absolute top-2 right-2 text-[10px] font-mono text-[var(--muted-foreground-3)]">04</span>
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Success rate
            </div>
            <div className="mt-1.5 text-xl font-bold font-sans tabular-nums text-[var(--success)]">
              {stats.successRate !== null ? `${stats.successRate}%` : "—"}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted-foreground-2)]">
              {stats.medianMs !== null ? `median run ${formatDuration(stats.medianMs)}` : "no completed runs yet"}
            </div>
          </button>
        </div>

        {runsError ? (
          <p role="alert" className="border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-3 py-2 text-xs text-[var(--destructive)]">
            Run history is unavailable: {runsError}
          </p>
        ) : null}

        <section aria-labelledby="capability-plane-title">
          <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
            One workspace · account-owned tools
          </p>
          <h3 id="capability-plane-title" className="mt-1 mb-3 text-lg font-sans">
            Your agent plane
          </h3>
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
                className="text-left border border-[var(--border-2)] bg-[var(--card)] p-4 hover:border-[var(--primary)]/35 hover:shadow-[var(--sh-card)] transition-all"
              >
                <span className="block text-[10px] font-mono text-[var(--muted-foreground-2)]">{capability.number} / CAPABILITY</span>
                <span className="block mt-2 font-sans text-lg text-[var(--fg)]">{capability.title}</span>
                <span className="block mt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{capability.detail}</span>
                <span className="block mt-3 text-[10px] font-mono uppercase tracking-wider text-[var(--primary)]">Open surface →</span>
              </button>
            ))}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Recent activity */}
          <section className="lg:col-span-3 paper-window rounded-[var(--radius-button)] overflow-hidden">
            <header className="bez-titlebar">
              <h3 className="text-[11px] font-mono tracking-[0.08em]">recent.activity</h3>
              <button
                type="button"
                onClick={() => onNavigate("analytics")}
                className="text-[10px] font-mono uppercase tracking-[0.1em] text-white/90 hover:text-white transition-colors"
              >
                View all runs →
              </button>
            </header>
            {recentRuns.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-[var(--muted-foreground-2)]">No runs yet.</p>
                <button
                  type="button"
                  onClick={onNewTask}
                  className="mt-3 text-[13px] font-semibold text-[var(--primary)] hover:text-[var(--primary)] transition-colors"
                >
                  Delegate your first task →
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border-1)]">
                {recentRuns.map((run) => (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => onInspectRun(run.runId)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[var(--card)]/70 transition-colors text-left"
                    >
                      <span
                        className={`shrink-0 text-[10px] font-bold uppercase tracking-wider border rounded-[var(--radius-button)] px-2 py-0.5 ${statusChipClass(run.status)}`}
                      >
                        {statusLabel(run.status)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-medium truncate">{run.task}</span>
                        <span className="block text-[11px] font-mono text-[var(--muted-foreground-2)] truncate">
                          {parseRepoName(run.repoUrl)} · {run.baseBranch}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] font-mono text-[var(--muted-foreground-2)]">
                        {formatTimeAgo(run.updatedAt || run.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <footer className="bez-statusbar">
              <span>{recentRuns.length} shown</span>
              <span>{stats.active.length} in flight</span>
              <span>{stats.errors} errors</span>
            </footer>
          </section>

          {/* Right column: approvals queue + agents */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            <section className="paper-window rounded-[var(--radius-button)] overflow-hidden">
              <header className="bez-titlebar">
                <h3 className="text-[11px] font-mono tracking-[0.08em]">approvals.queue</h3>
                {approvalCount > 0 ? (
                  <span className="min-w-5 h-5 px-1.5 rounded-[var(--radius-button)] bg-[var(--warning-fg)] text-white text-[10px] font-mono flex items-center justify-center">
                    {approvalCount}
                  </span>
                ) : (
                  <span className="bez-marks" aria-hidden="true"><i /><i /><i /></span>
                )}
              </header>
              {approvalCount === 0 ? (
                <div className="px-4 py-6 flex items-center gap-2.5 text-[13px] text-[var(--success)]">
                  <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                  Nothing waiting on you.
                </div>
              ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                  {pendingApprovals.slice(0, 4).map((approval) => (
                    <li key={approval.approvalId} className="px-4 py-3">
                      <div className="text-[13px] font-medium truncate">{approval.tool}</div>
                      <div className="text-[11px] font-mono text-[var(--muted-foreground-2)]">chat session</div>
                    </li>
                  ))}
                  {storedApprovals.slice(0, 4).map((approval) => (
                    <li key={approval.approvalId} className="px-4 py-3">
                      <div className="text-[13px] font-medium truncate">{approval.task}</div>
                      <div className="text-[11px] font-mono text-[var(--muted-foreground-2)] truncate">
                        {parseRepoName(approval.repoUrl)} · {approval.kind ?? "run"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {approvalCount > 0 ? (
                <div className="px-4 py-3 border-t border-[var(--border-1)]">
                  <button
                    type="button"
                    onClick={() => onNavigate("approvals")}
                    className="w-full min-h-9 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--warning-fg)_40%,transparent)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)] hover:bg-[var(--warning-fg)]/15 text-[var(--warning-fg)] text-xs font-semibold transition-colors"
                  >
                    Review Approvals
                  </button>
                </div>
              ) : null}
            </section>

            <section className="paper-window rounded-[var(--radius-button)] overflow-hidden">
              <header className="bez-titlebar">
                <h3 className="text-[11px] font-mono tracking-[0.08em]">agents</h3>
                <span className="text-[10px] font-mono text-white/90">
                  {liveAgents}/{agents.length} live
                </span>
              </header>
              {agents.length === 0 ? (
                <div className="px-4 py-6 text-[13px] text-[var(--muted-foreground-2)]">
                  No MCP principals registered yet.
                </div>
              ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                  {agents.slice(0, 5).map((agent) => (
                    <li key={agent.principal} className="px-4 py-2.5 flex items-center gap-2.5">
                      <span
                        className={`size-1.5 rounded-full shrink-0 ${agent.live ? "bg-[var(--success)]" : "bg-[var(--muted-foreground-3)]/40"}`}
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0 text-[13px] font-medium truncate">{agent.principal}</span>
                      <span className="shrink-0 text-[10px] font-mono text-[var(--muted-foreground-2)]">
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
    </div>
  );
}
