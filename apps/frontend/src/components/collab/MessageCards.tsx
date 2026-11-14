import type { JSX } from "react";
import type { PendingApproval } from "../../ui-helpers";
import { ApprovalCard } from "../ApprovalCard";

export interface ThreadCardMessage {
  messageKind?: string;
  body: string;
  fromLabel?: string;
  toLabel?: string;
  approval?: PendingApproval;
}

/**
 * Approval cards use ApprovalCard. Question cards use the same decision
 * surface once AskUserCard is exported beside it; until then the question
 * stays in the thread as a card the room can answer.
 */
export function MessageCards({
  message,
  onDecideApproval,
}: {
  message: ThreadCardMessage;
  onDecideApproval?: (approvalId: string, approved: boolean) => void;
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
  if (message.messageKind === "handoff" || message.messageKind === "handoff_report") {
    const from = message.fromLabel?.trim() || "Fixer";
    const to = message.toLabel?.trim() || "Reviewer";
    return (
      <p role="status" className="mt-2 text-sm text-[var(--ink)]">
        {from} → {to}
      </p>
    );
  }
  return null;
}
