import { Loader2, Plus } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

export interface WorkQuickAddProps {
  /** Resolve `false` (or reject) to keep the draft; any other result clears it. */
  onSubmit(text: string): void | boolean | Promise<boolean | void>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  failureMessage?: string;
}

export function WorkQuickAdd({
  onSubmit,
  disabled = false,
  placeholder = "Add a task and press Enter",
  className = "",
  "aria-label": ariaLabel,
  failureMessage = "Could not create the task. Your draft has been kept. Try again.",
}: WorkQuickAddProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = onSubmit(trimmed);
      if (result instanceof Promise) {
        setPending(true);
        if ((await result) !== false) setText("");
      } else if (result !== false) {
        setText("");
      }
    } catch {
      setError(failureMessage);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const Icon = pending ? Loader2 : Plus;

  return (
    <form
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        className={`w-full flex items-center gap-2 px-2.5 min-h-11 lg:min-h-8 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg bg-transparent transition-colors hover:border-zinc-400 dark:hover:border-zinc-600 focus-within:border-solid focus-within:border-zinc-400 dark:focus-within:border-zinc-500 ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-text"
        } ${className}`.trim()}
      >
        <Icon
          className={`w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0 ${pending ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        {/* readOnly (not disabled) while pending so focus stays in the bar for the next task. */}
        <input
          type="text"
          value={text}
          disabled={disabled}
          readOnly={pending}
          placeholder={placeholder}
          aria-label={ariaLabel || placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed read-only:text-zinc-500"
        />
        {pending ? <span className="sr-only">Adding task</span> : null}
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--destructive-fg)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
