// ApprovalCard — the sacred approval gate UI. waiting-approval tool calls
// surface this card with Approve/Reject wired to chat.addToolApprovalResponse
// via the parent's onDecideApproval. Never auto-approve; never hide.
import type { JSX } from "react";
import { Ban, Check } from "lucide-react";
import type { PendingApproval } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

export interface ApprovalCardProps {
  approval: PendingApproval;
  decided: boolean;
  /** The boolean outcome of the decision, when known — shown after the
   *  buttons settle so the card reads as a resolved record, not a dead form. */
  decision?: boolean;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
  /** Agent requesting the approval — the orchestrator instance driving the chat. */
  agentName?: string;
  /** Frozen composer flag. The tool-call JSON may omit it. */
  reviewAfterPublish?: boolean;
}

export function ApprovalCard({ approval, decided, decision, onDecideApproval, agentName, reviewAfterPublish }: ApprovalCardProps): JSX.Element {
  const rawTestCommand =
    typeof approval.input === "object" && approval.input !== null && !Array.isArray(approval.input)
      ? (approval.input as Record<string, unknown>)["testCommand"]
      : undefined;
  const testCommand =
    Array.isArray(rawTestCommand) &&
    rawTestCommand.length > 0 &&
    rawTestCommand.every((part): part is string => typeof part === "string" && part.length > 0)
      ? rawTestCommand.join(" ")
      : undefined;
  return (
    <div className="bg-[var(--bg)] overflow-hidden">
      <div className="flex items-center px-4 min-h-11 text-xs text-[var(--muted-foreground-2)]" role="status">
        {decided && decision !== undefined
          ? decision ? "Approved — sandbox starting" : "Rejected — nothing ran"
          : decided ? "Decision recorded" : "Waiting for your approval"}
      </div>
      <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono font-bold text-sm text-[var(--fg)] flex items-center gap-2 min-w-0">
          <Tooltip content="Nothing runs until you approve" side="bottom">
            <img
              src="/assets/mascot/pet-logo.png"
              alt="Shiba Guard"
              className="w-5 h-5 rounded-full bg-[var(--card)] object-contain border border-[var(--warning)]/50 shrink-0 cursor-default"
            />
          </Tooltip>
          <span className="truncate">{approval.tool}</span>
        </div>
        {decided && decision !== undefined ? (
          <span className={`text-xs font-medium border px-2 py-0.5 rounded-[var(--radius-button)] shrink-0 ${
            decision
              ? "bg-[var(--success)]/15 border-[color-mix(in_oklch,var(--success)_30%,transparent)] text-[var(--success)]"
              : "bg-[var(--destructive-soft)] border-[var(--destructive)] text-[var(--destructive)]"
          }`}>
            {decision ? "Approved" : "Rejected"}
          </span>
        ) : (
          <span className="text-xs font-medium bg-[var(--warning-fg)]/15 border border-[color-mix(in_oklch,var(--warning-fg)_30%,transparent)] text-[var(--warning-fg)] px-2 py-0.5 rounded-[var(--radius-button)] shrink-0">
            {decided ? "Decision recorded" : "Needs approval"}
          </span>
        )}
      </div>

      {agentName !== undefined ? (
        <p className="text-[10px] font-mono text-[var(--muted-foreground-2)] truncate -mt-1">via {agentName}</p>
      ) : null}

      {testCommand !== undefined ? (
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
          <span className="font-semibold text-[var(--fg)]">Tests:</span> {testCommand}
        </p>
      ) : null}

      <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--muted-foreground-2)] bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] max-h-56 overflow-auto">
        {typeof approval.input === "string"
          ? approval.input
          : JSON.stringify(approval.input, null, 2)}
      </pre>

      {reviewAfterPublish ||
      (typeof approval.input === "object" &&
        approval.input !== null &&
        !Array.isArray(approval.input) &&
        (approval.input as Record<string, unknown>).reviewAfterPublish === true) ? (
        <p className="text-xs text-[var(--fg)] leading-relaxed">
          After the PR opens, a read-only review will run and Shiba will post its findings as a PR review.
        </p>
      ) : null}

      <p className="text-xs text-[var(--muted-foreground-2)] leading-relaxed">
        Approve to run this in an isolated sandbox with the payload above. Reject to cancel — no container starts.
      </p>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Tooltip content="Approve tool execution inside isolated container" side="top">
          <button
            type="button"
            className="bg-[var(--inverse)] hover:bg-[var(--inverse-hover)] text-[var(--inverse-text)] font-medium min-h-11 min-w-11 px-4 rounded-lg transition-colors disabled:opacity-60 text-sm flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            disabled={decided}
            onClick={() => onDecideApproval(approval.approvalId, true)}
          >
            <Check aria-hidden="true" className="w-4 h-4" strokeWidth={2.5} />
            <span>{decided && decision === true ? "Approved" : "Approve"}</span>
          </button>
        </Tooltip>

        <Tooltip content="Reject tool execution and cancel operation" side="top">
          <button
            type="button"
            className="bg-[var(--secondary)] hover:bg-[var(--secondary-hover)] text-[var(--fg)] font-medium min-h-11 min-w-11 px-4 rounded-lg transition-colors disabled:opacity-60 text-sm flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            disabled={decided}
            onClick={() => onDecideApproval(approval.approvalId, false)}
          >
            <Ban aria-hidden="true" className="w-4 h-4" strokeWidth={2.5} />
            <span>{decided && decision === false ? "Rejected" : "Reject"}</span>
          </button>
        </Tooltip>
      </div>
      </div>
    </div>
  );
}
