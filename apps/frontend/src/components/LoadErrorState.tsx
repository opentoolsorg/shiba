import type { JSX } from "react";

/** Inline failed-fetch state for list panels, so a load error never reads as "empty". */
export function LoadErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 py-8 border border-dashed border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] rounded-[var(--radius-button)] bg-[var(--destructive)]/5 text-center px-4"
    >
      <p className="text-xs text-[var(--destructive)] break-words">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs font-semibold text-[var(--primary)] border border-[var(--primary)]/40 bg-[var(--primary-soft)] hover:bg-[var(--primary-soft-hover)] rounded-[var(--radius-button)] px-3 py-1.5 touch:min-h-11 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
