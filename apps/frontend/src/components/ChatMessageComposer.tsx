import { type FormEvent, type JSX, type KeyboardEvent, type ReactNode, type RefObject, useRef } from "react";
import { ArrowUp, AtSign, BookOpen, Globe2, LoaderCircle, Mic, Plus, Square } from "lucide-react";
import type { ChatLookupId, ChatLookupOption } from "../chat-lookups";
import { useVoiceInput } from "../hooks/useVoiceInput";

const CREATE_CHOICES = ["image", "video", "report", "page"] as const;
export type ChatCreateChoice = typeof CREATE_CHOICES[number];

export function ChatMessageComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  onRetry,
  busy,
  streaming,
  failed,
  placeholder = "What do you want to get done?",
  agentName = "Shiba",
  onAttach,
  onMention,
  mentionOpen,
  textareaRef,
  onPrepareWork,
  lookups = [],
  onToggleLookup,
  createChoice,
  onCreateChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRetry: () => void;
  busy: boolean;
  streaming: boolean;
  failed: boolean;
  placeholder?: string;
  agentName?: string;
  onAttach?: () => void;
  onMention?: () => void;
  mentionOpen?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Opens the existing Work editor with this same draft; never submits or approves it. */
  onPrepareWork?: () => void;
  /** Read-only lookups (web, knowledge) the next Chat message may use; off unless the person turns them on. */
  lookups?: readonly ChatLookupOption[];
  onToggleLookup?: (id: ChatLookupId) => void;
  createChoice?: ChatCreateChoice;
  onCreateChange?: (choice?: ChatCreateChoice) => void;
  children?: ReactNode;
}): JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null);
  const voice = useVoiceInput({
    disabled: busy || streaming,
    onTranscript: (text) => onChange(value.trim() ? `${value.trim()} ${text}` : text),
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy && !streaming && value.trim() !== "") {
        formRef.current?.requestSubmit();
      }
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col">
      <form
        ref={formRef}
        id="chat-message-composer"
        data-testid="chat-composer"
        aria-label="Chat composer"
        onSubmit={onSubmit}
        className="w-full [container-type:inline-size] rounded-2xl border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-composer)] flex flex-col p-3 sm:p-4 gap-2.5 relative group focus-within:border-[var(--ring)] transition-colors"
      >
        <label htmlFor="chat-message" className="sr-only">Message {agentName}</label>
        <textarea
          ref={textareaRef}
          id="chat-message"
          aria-label={`Message ${agentName}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          maxLength={8000}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:outline-none disabled:opacity-60 min-h-[72px]"
          disabled={streaming}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pt-1 [@container(min-width:42rem)]:flex">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label="Add to message"
              onClick={onAttach}
              className="inline-flex items-center justify-center size-11 rounded-full border border-[var(--border-1)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
            <button
              type="button"
              aria-label={voice.recording ? "Stop voice input" : "Voice input"}
              disabled={busy || streaming || voice.busy}
              onClick={voice.toggle}
              className="inline-flex items-center justify-center size-11 rounded-full border border-[var(--border-1)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:opacity-50"
            >
              <Mic aria-hidden="true" className={`size-4 ${voice.recording ? "text-[var(--destructive)]" : ""}`} />
            </button>
            <button
              type="button"
              aria-label="Mention"
              aria-haspopup={onMention ? "menu" : undefined}
              aria-expanded={onMention ? Boolean(mentionOpen) : undefined}
              onClick={onMention}
              className="inline-flex items-center justify-center size-11 rounded-full border border-[var(--border-1)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <AtSign aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="col-span-2 row-start-2 flex flex-wrap items-center gap-1.5">
            {onToggleLookup && lookups.length ? (
              <div role="group" aria-label="Lookups for this message" className="flex flex-wrap items-center gap-1.5">
                {lookups.map((lookup) => {
                  const Icon = lookup.id === "web_search" ? Globe2 : BookOpen;
                  return (
                    <button
                      key={lookup.id}
                      type="button"
                      aria-pressed={lookup.on}
                      disabled={!lookup.available || streaming}
                      title={lookup.available
                        ? `${lookup.on ? "Turn off" : "Turn on"} the ${lookup.label.toLowerCase()} lookup.${
                          lookup.id === "knowledge_search" ? " It searches your personal files and notes." : ""
                        } It stays on for later Chat messages until you turn it off.`
                        : lookup.unavailableReason}
                      onClick={() => onToggleLookup(lookup.id)}
                      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
                        lookup.on
                          ? "border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]"
                          : "border-[var(--border-1)] text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]"
                      }`}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                      {lookup.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {onCreateChange ? (
              <select
                aria-label="Create for this message"
                title="Choose one output for this message only. Choose None to clear."
                value={createChoice ?? ""}
                onChange={(event) => onCreateChange(CREATE_CHOICES.find((choice) => choice === event.target.value))}
                disabled={busy || streaming}
                className="min-h-11 max-w-full rounded-full border border-[var(--border-1)] bg-[var(--card)] px-2 text-xs font-medium text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] disabled:opacity-50"
              >
                <option value="">Create: None</option>
                {CREATE_CHOICES.map((choice) => <option key={choice} value={choice}>{choice.charAt(0).toUpperCase() + choice.slice(1)}</option>)}
              </select>
            ) : null}
          </div>
          <span className="sr-only min-w-0 text-[10px] font-mono text-[var(--muted-foreground-3)] [@container(min-width:42rem)]:not-sr-only">
            {streaming ? (
              <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
                <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                SHIBA IS RESPONDING
              </span>
            ) : lookups.some((lookup) => lookup.on)
              ? `CHAT MODE · ${lookups.filter((lookup) => lookup.on).map((lookup) => lookup.label.toUpperCase()).join(" + ")} LOOKUP`
              : "CHAT MODE"}
          </span>
          <div className="col-start-2 row-start-1 ml-auto flex items-center gap-2">
            {failed ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy || streaming}
                className="inline-flex min-h-11 items-center border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--fg)] rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Retry response"
              >
                Retry response
              </button>
            ) : null}
            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex min-h-11 items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--destructive)] hover:border-[var(--destructive)] rounded-full transition-colors"
                aria-label="Stop response"
              >
                <Square className="size-3" aria-hidden="true" />
                Stop
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy || streaming || value.trim() === ""}
              className="inline-flex items-center justify-center size-11 rounded-full bg-[var(--primary)] text-[var(--primary-text)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-all shadow-[var(--sh-plate)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              aria-label="Send message"
            >
              <ArrowUp className="size-4" strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        </div>
        {children}
        {onPrepareWork ? (
          <aside aria-label="Turn this draft into work" className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-3 text-xs text-[var(--ink-2)]">
            <p className="min-w-0 flex-1 basis-48">Ready to delegate? Review this draft’s target, employee and instructions in Work. Execution requires human approval.</p>
            <button type="button" onClick={onPrepareWork} disabled={busy || streaming || !value.trim()}
              className="min-h-11 shrink-0 border border-[var(--line)] bg-[var(--paper)] px-3 text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--navy)]">
              Review as work
            </button>
          </aside>
        ) : null}
      </form>
      <p className="mt-2 text-center text-xs text-[var(--muted-foreground-2)]">
        {agentName} can make mistakes. Check important info.
      </p>
    </div>
  );
}
