import type { JSX } from "react";
import type { PendingApproval } from "../../ui-helpers";
import { ApprovalCard } from "../ApprovalCard";
import { HandoffCard, HandoffReport, handoffReason, type HandoffCardStatus } from "./HandoffCard";
import { RouterChip, type RouterCandidate } from "./RouterChip";

export interface ThreadCardMessage {
  messageKind?: string;
  body: string;
  fromLabel?: string;
  toLabel?: string;
  approval?: PendingApproval;
  handoffStatus?: HandoffCardStatus;
  routerCandidates?: RouterCandidate[];
}

/**
 * Approval cards use ApprovalCard. Question cards use the same decision
 * surface once AskUserCard is exported beside it; until then the question
 * stays in the thread as a card the room can answer.
 */
export function MessageCards({
  message,
  onDecideApproval,
  onOpenThread,
  onReassign,
}: {
  message: ThreadCardMessage;
  onDecideApproval?: (approvalId: string, approved: boolean) => void;
  onOpenThread?: () => void;
  onReassign?: (actorId: string) => void;
}): JSX.Element | null {
  if (message.messageKind === "approval_card" && message.approval && onDecideApproval) {
    return (
      <ApprovalCard
        approval={message.approval}
        decided={false}
        onDecideApproval={onDecideApproval}
      />
    );
  }
  if (message.messageKind === "question_card") {
    return (
      <div role="status" aria-label="Question" className="mt-2 border border-[var(--line)] p-3 text-sm">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">Question</p>
        <p className="mt-1 whitespace-pre-wrap">{message.body}</p>
      </div>
    );
  }
  if (message.messageKind === "handoff") {
    const reason = handoffReason(message.body);
    return (
      <div>
        <HandoffCard
          body={message.body}
          fromLabel={message.fromLabel}
          toLabel={message.toLabel}
          status={message.handoffStatus ?? "pending approval"}
          onOpenThread={onOpenThread}
        />
        {reason && onReassign ? (
          <RouterChip
            reason={reason}
            candidates={message.routerCandidates ?? []}
            runActive={message.handoffStatus === "working"}
            onReassign={onReassign}
          />
        ) : null}
      </div>
    );
  }
  if (message.messageKind === "handoff_report") {
    return <HandoffReport body={message.body} onOpenThread={onOpenThread} />;
  }
  return null;
}
