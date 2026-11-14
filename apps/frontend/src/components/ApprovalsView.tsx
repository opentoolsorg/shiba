import { CheckCheck, ChevronRight, PanelLeft, Search } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import type { StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import { ApprovalCard } from "./ApprovalCard";
import { AuditPanel } from "./AuditPanel";
import { HarnessSessionPanel } from "./HarnessSessionPanel";
import { LoadErrorState } from "./LoadErrorState";
import { DecidedApprovalRow, StoredApprovalCard } from "./WorkspacePanel";
import { MainCard, type Scope } from "./ui/ContextPanel";

export interface ApprovalsViewProps {
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (id: string, ok: boolean) => void;
  storedApprovals: StoredApproval[];
  storedDecisions: Record<string, boolean>;
  decidedStoredApprovals: StoredApproval[];
  storedApprovalsError: string | null;
  onDecideStoredApproval: (approval: StoredApproval, ok: boolean, claimAction?: "queue" | "new_branch" | "cancel") => void;
  claimConflicts?: Record<string, { actorId: string; branch: string; repo: string; runId: string }>;
  orchestratorName?: string | null;
  onRefresh?: () => void;
  reviewAfterPublishById?: Record<string, boolean>;
  /** Poll the live session only when this page is active. */
  liveHarness?: boolean;
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}

type OutcomeFilter = "all" | "approved" | "rejected" | "executed";

export function ApprovalsView({
  pendingApprovals,
  decisions,
  onDecideApproval,
  storedApprovals,
  storedDecisions,
  decidedStoredApprovals,
  storedApprovalsError,
  onDecideStoredApproval,
  claimConflicts,
  orchestratorName,
  onRefresh,
  reviewAfterPublishById,
  liveHarness = false,
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
}: ApprovalsViewProps): JSX.Element {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const totalPending =
    pendingApprovals.filter((a) => decisions[a.approvalId] === undefined).length +
    storedApprovals.filter((a) => storedDecisions[a.approvalId] === undefined).length;

  const matches = (value: unknown) =>
    JSON.stringify(value).toLowerCase().includes(query.toLowerCase());

  const filteredDecided = useMemo(
    () =>
      decidedStoredApprovals.filter((a) => {
        if (outcomeFilter === "rejected") return a.status === "rejected";
        if (outcomeFilter === "executed") return a.execution?.status === "executed";
        if (outcomeFilter === "approved")
          return a.status === "approved" && a.execution?.status !== "failed";
        return true;
      }),
    [decidedStoredApprovals, outcomeFilter],
  );

  const visiblePending = pendingApprovals.filter(matches);
  const visibleStored = storedApprovals.filter(matches);
  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";

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
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
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
                  Approvals
                </h1>
              </li>
            </ol>
            <span className="ml-2 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-xs text-[#71717a] dark:text-zinc-400 tabular-nums">
              {totalPending} open
            </span>
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {searchOpen ? (
            <input
              type="search"
              aria-label="Search approvals"
              placeholder="Search approvals…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
              autoFocus
              className="min-h-11 w-40 sm:w-56 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-xs text-[#0a0a0a] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            />
          ) : null}
          <button
            type="button"
            aria-label={searchOpen ? "Close approval search" : "Search approvals"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              setQuery("");
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[#e4e4e7] bg-white text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            <Search className="size-3.5" aria-hidden="true" />
          </button>
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="flex min-h-11 items-center rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#f4f4f5] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              Refresh
            </button>
          ) : null}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-h-0 text-[#0a0a0a] dark:text-zinc-100">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <HarnessSessionPanel enabled={liveHarness} />

          {storedApprovalsError !== null ? (
            <LoadErrorState
              message={`Approval queue: ${storedApprovalsError}`}
              onRetry={onRefresh ?? (() => {})}
            />
          ) : null}

          <section aria-labelledby="pending-approvals-heading" className="rounded-xl border border-[#e4e4e7] bg-white dark:border-zinc-800 dark:bg-zinc-900/40 p-4">
            <details open className="group">
              <summary className="min-h-11 cursor-pointer rounded-lg px-2 text-sm text-[#0a0a0a] dark:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">
                <h2 id="pending-approvals-heading" className="inline-flex items-center gap-2 py-1 font-medium text-sm">
                  <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />
                  Needs approval
                  <span className="text-xs text-[#71717a] dark:text-zinc-400 font-mono">
                    {totalPending}
                  </span>
                </h2>
              </summary>

              <div className="pt-3">
                {pendingApprovals.length + storedApprovals.length === 0 && storedApprovalsError !== null ? null : pendingApprovals.length + storedApprovals.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[#71717a] dark:text-zinc-400">
                    <CheckCheck aria-hidden="true" className="size-6 text-[#71717a] dark:text-zinc-400" />
                    <p className="text-sm">Nothing needs you</p>
                  </div>
                ) : visiblePending.length + visibleStored.length === 0 ? (
                  <p className="py-12 text-center text-sm text-[#71717a] dark:text-zinc-400">
                    No matching approvals
                  </p>
                ) : (
                  <div className="flex flex-col divide-y divide-[#e4e4e7] border-y border-[#e4e4e7] dark:divide-zinc-800 dark:border-zinc-800">
                    {visiblePending.map((approval) => (
                      <ApprovalCard
                        key={approval.approvalId}
                        approval={approval}
                        decided={decisions[approval.approvalId] !== undefined}
                        decision={decisions[approval.approvalId]}
                        onDecideApproval={onDecideApproval}
                        agentName={orchestratorName ?? undefined}
                        reviewAfterPublish={reviewAfterPublishById?.[approval.approvalId]}
                      />
                    ))}
                    {visibleStored.map((approval) => (
                      <StoredApprovalCard
                        key={approval.approvalId}
                        approval={approval}
                        decided={storedDecisions[approval.approvalId] !== undefined}
                        decision={storedDecisions[approval.approvalId]}
                        onDecide={onDecideStoredApproval}
                        conflict={claimConflicts?.[approval.approvalId] ?? null}
                        onClaimChoice={(choice) => onDecideStoredApproval(approval, choice !== "cancel", choice)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </details>
          </section>

          {decidedStoredApprovals.length > 0 ? (
            <section aria-labelledby="recent-outcomes-heading" className="rounded-xl border border-[#e4e4e7] bg-white dark:border-zinc-800 dark:bg-zinc-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e4e7] pb-3 dark:border-zinc-800">
                <h2 id="recent-outcomes-heading" className="text-sm font-medium text-[#0a0a0a] dark:text-zinc-100">
                  Decided{" "}
                  <span className="ml-1.5 text-xs text-[#71717a] dark:text-zinc-400 font-mono">
                    {decidedStoredApprovals.length}
                  </span>
                </h2>
                <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-[#f4f4f5] p-0.5 dark:bg-zinc-800">
                  {(["all", "approved", "rejected", "executed"] as OutcomeFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setOutcomeFilter(f)}
                      aria-pressed={outcomeFilter === f}
                      className={
                        "min-h-11 rounded px-3 text-xs capitalize transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] " +
                        (outcomeFilter === f
                          ? "bg-white font-medium text-[#0a0a0a] shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-zinc-900 dark:text-zinc-100"
                          : "text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-200")
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-2">
                {filteredDecided.filter(matches).length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-[#71717a] dark:text-zinc-400">
                    No decided actions match the “{outcomeFilter}” filter.
                  </p>
                ) : (
                  <div className="divide-y divide-[#e4e4e7] dark:divide-zinc-800">
                    {filteredDecided.filter(matches).map((approval) => (
                      <DecidedApprovalRow key={approval.approvalId} approval={approval} />
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : null}

          <section aria-label="Audit log" className="pt-2">
            <AuditPanel />
          </section>
        </div>
      </div>
    </MainCard>
  );
}
