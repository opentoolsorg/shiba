import type { JSX } from "react";

export function OwnerChip({ owner }: { owner: string }): JSX.Element {
  return (
    <span className="inline-flex min-h-6 items-center border border-[var(--line)] px-2 font-mono text-[10px] text-[var(--ink)]">
      Owns this · {owner}
    </span>
  );
}
