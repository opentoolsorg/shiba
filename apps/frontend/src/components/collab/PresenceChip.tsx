import type { JSX } from "react";

export type PresenceState = "online" | "away" | "working";

const DOT: Record<PresenceState, string> = {
  online: "bg-[var(--success)]",
  away: "bg-[var(--ink-2)]",
  working: "bg-[var(--warning-fg)]",
};

export function PresenceChip({ state, label }: { state: PresenceState; label: string }): JSX.Element {
  return (
    <span className="inline-flex min-h-6 items-center gap-1 text-[10px] text-[var(--ink-2)]">
      <span className={`inline-block size-2 rounded-full ${DOT[state]}`} aria-hidden="true" />
      <span className="sr-only">{state}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}
