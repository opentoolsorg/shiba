/** Shared chrome for Settings surfaces — Capy token-based card. */
import type { JSX, ReactNode } from "react";

export function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)] overflow-hidden">
      {children}
    </div>
  );
}
