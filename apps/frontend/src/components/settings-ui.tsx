/** Shared chrome for Settings surfaces — token-based card and rows. */
import type { JSX, ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs overflow-hidden ${className}`.trim()}
    >
      {children}
    </div>
  );
}
