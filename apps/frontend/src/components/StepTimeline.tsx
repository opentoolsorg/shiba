/**
 * StepTimeline — Devin-style conversation feed.
 * User messages render as right-aligned blue bubbles; assistant/tool parts
 * render as steps on a left icon rail with a vertical connecting line.
 * waiting-approval tool parts also render the inline approval card —
 * the approval gate is sacred: never auto-approve, never hide.
 */
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
import { memo, type CSSProperties } from "react";
import { LoaderCircle, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { RetainedDraftCard } from "./RetainedDraftCard";
import { Tooltip } from "./Tooltip";
import {
  formatToolOutput,
  toolDisplayName,
  type PendingApproval,
  type ToolPart,
} from "../ui-helpers";

export interface StepTimelineProps {
  messages: UIMessage[];
  isStreaming: boolean;
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
  renderToolOutput?: (part: ToolPart) => string | null; // optional, has default
  starters?: { icon: LucideIcon; label: string; task: string }[];
  onStarter?: (task: string) => void;
  reviewAfterPublishById?: Record<string, boolean>;
}

function partText(part: ToolPart): string | null {
  if (typeof part !== "object" || part === null) return null;
  const typed = part as { type?: unknown; text?: unknown };
  if (typed.type === "text" && typeof typed.text === "string") {
    return typed.text;
  }
  return null;
}

function RailIcon({ kind }: { kind: "tool" | "text" | "approval" }) {
  if (kind === "text") {
    return (
      <img
        src="/assets/mascot/pet-logo.png"
        alt=""
        className="w-4 h-4 rounded-full bg-white object-contain"
      />
    );
  }
  if (kind === "approval") {
    return <ShieldCheck className="w-3 h-3" strokeWidth={2} aria-hidden="true" />;
  }
  return <Wrench className="w-3 h-3" strokeWidth={2} aria-hidden="true" />;
}

function statusChipClass(rejected: boolean, waiting: boolean): string {
  if (rejected) return "text-[var(--destructive)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)]";
  if (waiting) return "text-[var(--warning-fg)] border-[color-mix(in_oklch,var(--warning-fg)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)]";
  return "text-[var(--muted-foreground-2)] border-[var(--border-1)] bg-[var(--panel)]";
}

export function StepTimeline({
  messages,
  isStreaming,
  pendingApprovals,
  decisions,
  onDecideApproval,
  renderToolOutput = formatToolOutput,
  starters,
  onStarter,
  reviewAfterPublishById,
}: StepTimelineProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--panel)]/40 px-6 text-center animate-enter">
        <img
          src="/assets/mascot/shiba-sticker-hero.webp"
          alt="Shiba illustration mascot"
          className="w-56 h-auto max-h-40 rounded-[var(--radius-button)] shadow-[var(--sh-overlay)] border border-[var(--primary)]/30 mb-3 object-cover"
        />
        <h2 className="font-sans text-3xl text-[var(--fg)] mb-1">
          Delegate the next task.
        </h2>
        <p className="text-[var(--muted-foreground-2)] text-sm mb-2 font-medium">
          No messages yet. Submit a task to start.
        </p>
        {starters && starters.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3 max-w-md">
            {starters.map((starter, starterIndex) => (
              <Tooltip key={starter.label} content={starter.task} side="bottom" delayMs={200}>
                <button
                  type="button"
                  onClick={() => onStarter?.(starter.task)}
                  style={{ "--enter-delay": `${150 + starterIndex * 60}ms` } as CSSProperties}
                  className="inline-flex items-center gap-1.5 text-xs text-[var(--fg)] bg-[var(--card)] hover:bg-[var(--secondary)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-3 py-1.5 touch:min-h-11 transition-colors active:scale-95 animate-enter"
                >
                  <span aria-hidden="true"><starter.icon className="w-3.5 h-3.5" strokeWidth={2} /></span>
                  {starter.label}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-5">
      {messages.map((message) => {
        if (message.role === "user") {
          return <UserMessageRow key={message.id} message={message} />;
        }

        // Assistant / tool steps on the left icon rail.
        return (
          <AssistantMessageRow
            key={message.id}
            message={message}
            pendingApprovals={pendingApprovals}
            decisions={decisions}
            onDecideApproval={onDecideApproval}
            renderToolOutput={renderToolOutput}
            reviewAfterPublishById={reviewAfterPublishById}
          />
        );
      })}

      {isStreaming ? (
        <li className="flex flex-col items-start">
          <div className="relative pl-9">
            <span className="absolute left-0 top-0.5 w-6 h-6 rounded-[var(--radius-button)] bg-[var(--panel)] border border-[var(--primary)]/40 flex items-center justify-center">
              <img
                src="/assets/mascot/pet-logo.png"
                alt=""
                className="w-4 h-4 rounded-full bg-white object-contain animate-bounce"
              />
            </span>
            <div className="bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] p-4 text-xs text-[var(--muted-foreground-2)] flex items-center gap-2 w-fit">
              <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
              <span className="text-[var(--primary)] font-semibold">Shiba is reasoning…</span>
            </div>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

// Memoized rows: unchanged messages (identity-stable across streaming
// updates) skip re-traversal entirely; `decisions`/`pendingApprovals`/
// callbacks stay in the prop list so an approval card can never freeze.

const UserMessageRow = memo(function UserMessageRow({
  message,
}: {
  message: UIMessage;
}) {
  return (
    <li className="flex flex-col items-end">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--muted-foreground-2)] uppercase tracking-wider mb-1 px-1">
        <span>You</span>
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)]" />
      </div>
      <div className="flex flex-col gap-2 max-w-[92%] md:max-w-[85%] bg-[var(--primary)] text-white rounded-[var(--radius-button)] p-4 font-medium shadow-[var(--sh-card)]">
        {message.parts.map((part, index) => {
          const text = partText(part);
          if (text === null) return null;
          return (
            <pre
              key={index}
              className="whitespace-pre-wrap font-sans text-sm break-words leading-relaxed"
            >
              {text}
            </pre>
          );
        })}
      </div>
    </li>
  );
});

interface AssistantMessageRowProps {
  message: UIMessage;
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
  renderToolOutput: (part: ToolPart) => string | null;
  reviewAfterPublishById?: Record<string, boolean>;
}

const AssistantMessageRow = memo(function AssistantMessageRow({
  message,
  pendingApprovals,
  decisions,
  onDecideApproval,
  renderToolOutput,
  reviewAfterPublishById,
}: AssistantMessageRowProps) {
  return (
    <li className="flex flex-col items-start">
      <div className="relative pl-9 flex flex-col gap-3 w-full before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-[var(--secondary)]">
        {message.parts.map((part, index) => {
          const text = partText(part);
          if (text !== null) {
            return (
              <div key={message.id + ":text:" + index} className="relative">
                <span className="absolute -left-9 top-0.5 w-6 h-6 rounded-[var(--radius-button)] bg-[var(--panel)] border border-[var(--border-1)] flex items-center justify-center text-[var(--muted-foreground-2)]">
                  <RailIcon kind="text" />
                </span>
                <div className="bg-[var(--panel)] border border-[var(--border-1)] text-[var(--fg)] rounded-[var(--radius-button)] p-4 shadow-[var(--sh-card)] max-w-[92%] md:max-w-[85%]">
                  <pre className="whitespace-pre-wrap font-sans text-sm break-words leading-relaxed">
                    {text}
                  </pre>
                </div>
              </div>
            );
          }

          if (isToolUIPart(part)) {
            const state = getToolPartState(part);
            const approval = getToolApproval(part);
            const rejected = approval?.approved === false;
            const waiting = state === "waiting-approval";
            const output = renderToolOutput(part);
            const retainedDraft = toolDisplayName(part) === "employee_retain_draft" && state === "complete"
              ? getToolOutput(part) : null;
            const callId = getToolCallId(part);
            // Build the gate card from the tool part itself; the
            // pendingApprovals join is only a decided-state lookup.
            const approvalId = approval?.id;
            const pendingApproval: PendingApproval | undefined =
              waiting && approvalId
                ? pendingApprovals.find((a) => a.approvalId === approvalId) ?? {
                    messageId: message.id,
                    toolCallId: callId,
                    approvalId,
                    tool: toolDisplayName(part),
                    input: getToolInput(part),
                  }
                : undefined;

            return (
              <div key={callId ?? (message.id + ":tool:" + index)} className="relative flex flex-col gap-3">
                <span
                  className={`absolute -left-9 top-0.5 w-6 h-6 rounded-[var(--radius-button)] bg-[var(--panel)] border flex items-center justify-center ${
                    waiting
                      ? "border-[var(--warning-fg)]/60 text-[var(--warning-fg)]"
                      : "border-[var(--border-1)] text-[var(--muted-foreground-2)]"
                  }`}
                >
                  <RailIcon kind={waiting ? "approval" : "tool"} />
                </span>
                <div className="flex flex-wrap items-center gap-2 bg-[var(--panel)]/70 p-2.5 rounded-[var(--radius-button)] border border-[var(--border-1)] font-mono text-xs w-fit max-w-full">
                  <span className="text-[var(--primary)] font-semibold bg-[var(--card)] px-2 py-0.5 rounded-[var(--radius-button)]">
                    Ran {toolDisplayName(part)}
                  </span>
                  <span
                    className={`text-[11px] font-semibold px-2 py-0.5 rounded-[var(--radius-button)] border ${statusChipClass(
                      rejected,
                      waiting,
                    )}`}
                  >
                    {rejected ? "Rejected" : state}
                  </span>
                </div>
                {retainedDraft ? <RetainedDraftCard output={retainedDraft} /> : output !== null && output !== "" ? (
                  <details className="max-w-[92%] md:max-w-[85%] group">
                    <summary className="cursor-pointer text-[11px] font-mono text-[var(--muted-foreground-2)] hover:text-[var(--fg)] transition-colors select-none">
                      Output
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-[var(--muted-foreground-2)] bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] max-h-56 overflow-auto">
                      {output}
                    </pre>
                  </details>
                ) : null}
                {waiting && pendingApproval ? (
                  <ApprovalCard
                    approval={pendingApproval}
                    decided={decisions[pendingApproval.approvalId] !== undefined}
                    onDecideApproval={onDecideApproval}
                    reviewAfterPublish={reviewAfterPublishById?.[pendingApproval.approvalId]}
                  />
                ) : null}
              </div>
            );
          }

          return null;
        })}
      </div>
    </li>
  );
});
