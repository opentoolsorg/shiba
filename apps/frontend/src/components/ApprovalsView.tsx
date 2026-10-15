import { useState, useMemo, type JSX } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { AuditPanel } from "./AuditPanel";
import {
  StoredApprovalCard,
  DecidedApprovalRow,
} from "./WorkspacePanel";
import type { PendingApproval } from "../ui-helpers";
import type { StoredApproval } from "../types";

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
  orchestratorName,
  onRefresh,
}: ApprovalsViewProps): JSX.Element {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const totalPending = pendingApprovals.length + storedApprovals.length;

  const filteredDecided = useMemo(() => {
    if (outcomeFilter === "all") return decidedStoredApprovals;
    return decidedStoredApprovals.filter((a) => {
      if (outcomeFilter === "rejected") return a.status === "rejected";
      if (outcomeFilter === "executed") return a.execution?.status === "executed";
      if (outcomeFilter === "approved") {
        return a.status === "approved" && a.execution?.status !== "failed";
      }
      return true;
    });
  }, [decidedStoredApprovals, outcomeFilter]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      {/* Top Header */}
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
            <span>Approvals & Decision Center</span>
            {totalPending > 0 ? (
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-[var(--radius-button)] bg-[#b45309] text-white">
                {totalPending} waiting
              </span>
            ) : (
              <span className="text-xs font-mono px-2 py-0.5 rounded-[var(--radius-button)] bg-[#15803d]/10 text-[#15803d] border border-[#15803d]/30">
                0 pending · all clear
              </span>
            )}
          </h2>
          <p className="text-xs text-[var(--muted-foreground-2)]">
            Human-in-the-loop review for sandbox tool calls, outbound communications, and cryptographic audit records.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider font-mono text-[var(--primary)]/80 bg-[var(--primary-soft)] border border-[var(--primary)]/20 px-2 py-1 rounded-[var(--radius-button)]">
            Zero-Trust Boundary
          </span>
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="text-xs font-medium text-[var(--fg)] bg-[var(--card)] hover:bg-[var(--secondary)] border border-[var(--border-1)] px-3 py-1.5 rounded-[var(--radius-button)] transition-colors"
            >
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {storedApprovalsError !== null ? (
            <div className="text-xs text-[#b91c1c] bg-[#fb2c36]/10 border border-[#fb2c36]/30 rounded-[var(--radius-button)] p-3.5 flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="w-4 h-4 text-[#b91c1c] shrink-0 mt-0.5" strokeWidth={2} />
              <span>Approval queue sync error: {storedApprovalsError}</span>
            </div>
          ) : null}

          {/* Section 1: Pending Approvals */}
          <section aria-labelledby="pending-approvals-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between pb-1 border-b border-[var(--border-1)]">
              <h3 id="pending-approvals-heading" className="text-sm font-semibold text-[var(--fg)] flex items-center gap-2">
                <span>Pending Approvals</span>
                {totalPending > 0 ? (
                  <span className="size-2 rounded-full bg-[#b45309]" aria-hidden="true" />
                ) : null}
              </h3>
              <span className="text-xs font-mono text-[var(--muted-foreground-2)]">
                {totalPending} item{totalPending === 1 ? "" : "s"}
              </span>
            </div>

            {totalPending === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] text-center p-6">
                <div className="w-10 h-10 rounded-full bg-[#15803d]/10 text-[#15803d] flex items-center justify-center mb-2">
                  <Check aria-hidden="true" className="w-5 h-5" strokeWidth={2} />
                </div>
                <h4 className="text-sm font-semibold text-[var(--fg)]">All Clear</h4>
                <p className="text-xs text-[var(--muted-foreground-2)] max-w-sm mt-0.5">
                  No actions are currently awaiting your approval. Outbound communications and privileged sandbox tasks will pause here when queued.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Chat Tool Approvals */}
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={decisions[approval.approvalId] !== undefined}
                    decision={decisions[approval.approvalId]}
                    onDecideApproval={onDecideApproval}
                    agentName={orchestratorName ?? undefined}
                  />
                ))}

                {/* Stored DO Approvals */}
                {storedApprovals.map((approval) => (
                  <StoredApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={storedDecisions[approval.approvalId] !== undefined}
                    onDecide={onDecideStoredApproval}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Section 2: Recent Decided Outcomes */}
          {decidedStoredApprovals.length > 0 ? (
            <section aria-labelledby="recent-outcomes-heading" className="flex flex-col gap-3">
              <div className="flex items-center justify-between pb-1 border-b border-[var(--border-1)] flex-wrap gap-2">
                <h3 id="recent-outcomes-heading" className="text-sm font-semibold text-[var(--fg)]">
                  Recent Outcomes & Decided Actions
                </h3>
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  {(["all", "approved", "rejected", "executed"] as OutcomeFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setOutcomeFilter(f)}
                      className={`px-2.5 py-1 border transition-colors capitalize ${
                        outcomeFilter === f
                          ? "border-[var(--primary)] bg-[var(--primary)] text-white font-bold"
                          : "border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {filteredDecided.length === 0 ? (
                <p className="border border-dashed border-[var(--border-1)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
                  No decided actions match the “{outcomeFilter}” filter.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredDecided.map((approval) => (
                    <DecidedApprovalRow key={approval.approvalId} approval={approval} />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {/* Section 3: Cryptographic Audit Trail */}
          <section aria-labelledby="audit-trail-heading" className="flex flex-col gap-3">
            <div className="pb-1 border-b border-[var(--border-1)]">
              <h3 id="audit-trail-heading" className="text-sm font-semibold text-[var(--fg)]">
                Cryptographic Audit Log (D1 + SHA-256)
              </h3>
            </div>
            <div className="bg-[var(--card)] border border-[var(--border-1)] p-4 rounded-[var(--radius-button)] shadow-[var(--sh-card)]">
              <AuditPanel />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
