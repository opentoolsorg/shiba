import { CheckCheck, Search } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import type { StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import { ApprovalCard } from "./ApprovalCard";
import { AuditPanel } from "./AuditPanel";
import { HarnessSessionPanel } from "./HarnessSessionPanel";
import { LoadErrorState } from "./LoadErrorState";
import { DecidedApprovalRow, StoredApprovalCard } from "./WorkspacePanel";

export interface ApprovalsViewProps {
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (id: string, ok: boolean) => void;
  storedApprovals: StoredApproval[];
  storedDecisions: Record<string, boolean>;
  decidedStoredApprovals: StoredApproval[];
  storedApprovalsError: string | null;
  onDecideStoredApproval: (approval: StoredApproval, ok: boolean) => void;
  orchestratorName?: string | null;
  onRefresh?: () => void;
  reviewAfterPublishById?: Record<string, boolean>;
  /** Poll the live session only when this page is active. */
  liveHarness?: boolean;
}

type OutcomeFilter = "all" | "approved" | "rejected" | "executed";

export function ApprovalsView({
  pendingApprovals, decisions, onDecideApproval, storedApprovals, storedDecisions,
  decidedStoredApprovals, storedApprovalsError, onDecideStoredApproval,
  orchestratorName, onRefresh, reviewAfterPublishById, liveHarness = false,
}: ApprovalsViewProps): JSX.Element {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const totalPending = pendingApprovals.filter((a) => decisions[a.approvalId] === undefined).length
    + storedApprovals.filter((a) => storedDecisions[a.approvalId] === undefined).length;
  const matches = (value: unknown) => JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
  const filteredDecided = useMemo(() => decidedStoredApprovals.filter((a) => {
    if (outcomeFilter === "rejected") return a.status === "rejected";
    if (outcomeFilter === "executed") return a.execution?.status === "executed";
    if (outcomeFilter === "approved") return a.status === "approved" && a.execution?.status !== "failed";
    return true;
  }), [decidedStoredApprovals, outcomeFilter]);
  const visiblePending = pendingApprovals.filter(matches);
  const visibleStored = storedApprovals.filter(matches);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2 border-b border-[var(--border-1)] bg-[var(--chrome)] min-h-14 shrink-0">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted-foreground-2)]">
          <span>Personal</span><span aria-hidden="true">&gt;</span>
          <h1 className="font-sans font-medium text-[var(--fg)]">Approvals</h1><span aria-hidden="true">&gt;</span>
          <span>Inbox</span><span className="rounded-full bg-[var(--section)] px-2 py-1 text-xs">{totalPending} open</span>
        </div>
        <div className="flex items-center gap-2">
          {searchOpen ? <input type="search" aria-label="Search approvals" placeholder="Search approvals…" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-11 w-40 sm:w-56 rounded-lg border border-[var(--border-1)] bg-[var(--input)] px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]" /> : null}
          <button type="button" aria-label={searchOpen ? "Close approval search" : "Search approvals"} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }} className="size-11 rounded-lg flex items-center justify-center text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"><Search className="size-4" aria-hidden="true" /></button>
          {onRefresh ? <button type="button" onClick={onRefresh} className="min-h-11 rounded-lg bg-[var(--secondary)] px-3 text-sm font-medium hover:bg-[var(--secondary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Refresh</button> : null}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-5">
          <HarnessSessionPanel enabled={liveHarness} />
          {storedApprovalsError !== null ? <LoadErrorState message={`Approval queue: ${storedApprovalsError}`} onRetry={onRefresh ?? (() => {})} /> : null}
          <section aria-labelledby="pending-approvals-heading">
            <details open className="group">
              <summary className="min-h-11 cursor-pointer rounded-lg px-2 text-sm text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
                <h2 id="pending-approvals-heading" className="inline-flex items-center gap-2 py-3 font-sans font-medium"><span aria-hidden="true" className="size-2 rounded-full border-2 border-[var(--warning-fg)]" />Needs approval<span className="text-xs text-[var(--muted-foreground-2)]">{totalPending}</span></h2>
              </summary>
              {pendingApprovals.length + storedApprovals.length === 0 && storedApprovalsError !== null ? null : pendingApprovals.length + storedApprovals.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-20 text-[var(--muted-foreground-2)]"><CheckCheck aria-hidden="true" className="size-6" /><p className="text-sm">Nothing needs you</p></div>
              ) : visiblePending.length + visibleStored.length === 0 ? <p className="py-12 text-center text-sm text-[var(--muted-foreground-2)]">No matching approvals</p> : (
                <div className="flex flex-col divide-y divide-[var(--border-1)] border-y border-[var(--border-1)]">
                  {visiblePending.map((approval) => <ApprovalCard key={approval.approvalId} approval={approval} decided={decisions[approval.approvalId] !== undefined} decision={decisions[approval.approvalId]} onDecideApproval={onDecideApproval} agentName={orchestratorName ?? undefined} reviewAfterPublish={reviewAfterPublishById?.[approval.approvalId]} />)}
                  {visibleStored.map((approval) => <StoredApprovalCard key={approval.approvalId} approval={approval} decided={storedDecisions[approval.approvalId] !== undefined} decision={storedDecisions[approval.approvalId]} onDecide={onDecideStoredApproval} />)}
                </div>
              )}
            </details>
          </section>
          {decidedStoredApprovals.length > 0 ? (
            <section aria-labelledby="recent-outcomes-heading">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] pb-2">
                <h2 id="recent-outcomes-heading" className="text-sm font-medium">Decided <span className="ml-2 text-xs text-[var(--muted-foreground-2)]">{decidedStoredApprovals.length}</span></h2>
                <div className="flex flex-wrap items-center gap-1 rounded-[10px] bg-[var(--section)] p-1">
                  {(["all", "approved", "rejected", "executed"] as OutcomeFilter[]).map((f) => <button key={f} type="button" onClick={() => setOutcomeFilter(f)} aria-pressed={outcomeFilter === f} className={`min-h-11 rounded-lg px-3 text-xs capitalize focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${outcomeFilter === f ? "bg-[var(--card)] text-[var(--fg)] shadow-sm" : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"}`}>{f}</button>)}
                </div>
              </div>
              {filteredDecided.filter(matches).length === 0 ? <p className="px-4 py-12 text-center text-sm text-[var(--muted-foreground-2)]">No decided actions match the “{outcomeFilter}” filter.</p> : <div className="divide-y divide-[var(--border-1)]">{filteredDecided.filter(matches).map((approval) => <DecidedApprovalRow key={approval.approvalId} approval={approval} />)}</div>}
            </section>
          ) : null}
          <section aria-label="Audit log" className="border-t border-[var(--border-1)] pt-4"><AuditPanel /></section>
        </div>
      </div>
    </div>
  );
}
