import { type FormEvent, type JSX, type KeyboardEvent, useRef } from "react";
import { ArrowUp, AtSign, LoaderCircle, Plus, Square } from "lucide-react";

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
}): JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
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
        data-testid="chat-composer"
        aria-label="Chat composer"
        onSubmit={onSubmit}
        className="w-full rounded-2xl border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-composer)] flex flex-col p-3 sm:p-4 gap-2.5 relative group focus-within:border-[var(--ring)] transition-colors"
      >
        <label htmlFor="chat-message" className="sr-only">Message Shiba</label>
        <textarea
          id="chat-message"
          aria-label="Message Shiba"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          maxLength={8000}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:outline-none disabled:opacity-60 min-h-[72px]"
          disabled={streaming}
        />
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Add to message"
              className="inline-flex items-center justify-center size-9 rounded-full border border-[var(--border-1)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Mention"
              className="inline-flex items-center justify-center size-9 rounded-full border border-[var(--border-1)] hover:bg-[var(--secondary)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              <AtSign aria-hidden="true" className="size-4" />
            </button>
            <span className="text-[10px] font-mono text-[var(--muted-foreground-3)] ml-1">
              {streaming ? (
                <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                  SHIBA IS RESPONDING
                </span>
              ) : "CHAT MODE · TASK TOOLS ARE OFF"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {failed ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy || streaming}
                className="inline-flex min-h-9 items-center border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--fg)] rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Retry response"
              >
                Retry response
              </button>
            ) : null}
            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--destructive)] hover:border-[var(--destructive)] rounded-full transition-colors"
                aria-label="Stop response"
              >
                <Square className="size-3" aria-hidden="true" />
                Stop
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy || streaming || value.trim() === ""}
              className="inline-flex items-center justify-center size-10 rounded-full bg-[var(--primary)] text-[var(--primary-text)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-all shadow-[var(--sh-plate)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
              aria-label="Send message"
            >
              <ArrowUp className="size-4" strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
      <p className="mt-2 text-center text-xs text-[var(--muted-foreground-2)]">
        Shiba can make mistakes. Check important info.
      </p>
    </div>
  );
}
