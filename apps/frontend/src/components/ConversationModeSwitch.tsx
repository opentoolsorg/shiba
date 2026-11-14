import type { JSX } from "react";
import { MessageCircle, Workflow } from "lucide-react";
import type { ConversationMode } from "../conversation-mode";

export function ConversationModeSwitch({
  value,
  onChange,
  disabled = false,
}: {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line)] px-3 sm:px-5 xl:px-8 py-2 shrink-0">
      <div role="tablist" aria-label="Conversation mode" className="inline-flex items-center gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={value === "chat"}
          disabled={disabled}
          onClick={() => onChange("chat")}
          className={`inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs border disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--navy)] ${value === "chat" ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)]" : "border-transparent text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]"}`}
        >
          <MessageCircle className="size-3.5" aria-hidden="true" />
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value === "work"}
          disabled={disabled}
          onClick={() => onChange("work")}
          className={`inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs border disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--navy)] ${value === "work" ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)]" : "border-transparent text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]"}`}
        >
          <Workflow className="size-3.5" aria-hidden="true" />
          Work
        </button>
      </div>
      <span className="ml-auto hidden sm:inline text-[10px] font-mono text-[var(--muted-foreground-3)]">
        {value === "chat" ? "CONVERSATION · NO TASK TOOLS" : "APPROVAL-GATED EXECUTION"}
      </span>
      <p className="w-full text-xs text-[var(--ink-2)]">
        {value === "chat"
          ? "Use Chat to shape your plan. Switch to Work to review the same draft before requesting approval."
          : "Review the draft, employee and execution target below. Submitting work requests human approval before execution."}
      </p>
    </div>
  );
}
