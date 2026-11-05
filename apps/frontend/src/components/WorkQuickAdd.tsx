import React, { useRef, useState } from "react";
import { Plus } from "lucide-react";

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
  failureMessage = "Could not create a thread. Your draft has been kept. Try again.",
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
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText("");
    }
  };

  const inactive = disabled || pending;

  return (
    <form
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        className={`w-full flex items-center gap-2 px-2.5 min-h-11 lg:min-h-7 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg bg-transparent transition-colors focus-within:border-zinc-400 dark:focus-within:border-zinc-600 ${
          inactive ? "opacity-50 cursor-not-allowed" : "cursor-text"
        } ${className}`.trim()}
      >
        <Plus className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" aria-hidden="true" />
        <input
          type="text"
          value={text}
          disabled={inactive}
          placeholder={placeholder}
          aria-label={ariaLabel || placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--destructive-fg)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
