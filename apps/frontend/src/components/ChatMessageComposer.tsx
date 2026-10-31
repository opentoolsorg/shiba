import type { FormEvent, JSX } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";

export function ChatMessageComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  onRetry,
  busy,
  streaming,
  failed,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRetry: () => void;
  busy: boolean;
  streaming: boolean;
  failed: boolean;
}): JSX.Element {
  return (
    <form
      data-testid="chat-composer"
      aria-label="Chat composer"
      onSubmit={onSubmit}
      className="w-full max-w-3xl mx-auto border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-composer)] flex flex-col"
    >
      <label htmlFor="chat-message" className="sr-only">Message Shiba</label>
      <textarea
        id="chat-message"
        aria-label="Message Shiba"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="What should we explore?"
        rows={3}
        maxLength={8000}
        className="w-full resize-y bg-transparent px-4 py-4 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:outline-none disabled:opacity-60"
        disabled={streaming}
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <span className="text-[10px] font-mono text-[var(--muted-foreground-3)]">
          {streaming ? (
            <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5">
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              SHIBA IS RESPONDING
            </span>
          ) : "CHAT MODE · TASK TOOLS ARE OFF"}
        </span>
        <div className="flex items-center gap-2">
          {failed ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy || streaming}
              className="inline-flex min-h-9 items-center border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Retry response"
            >
              Retry response
            </button>
          ) : null}
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:text-[var(--destructive)] hover:border-[var(--destructive)]"
              aria-label="Stop response"
            >
              <Square className="size-3" aria-hidden="true" />
              Stop
            </button>
          ) : null}
          <button
            type="submit"
            disabled={busy || streaming || value.trim() === ""}
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--primary)] bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-text)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send message"
          >
            Send
            <ArrowUp className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}
