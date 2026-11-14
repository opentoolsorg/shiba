import type { JSX, ReactNode } from "react";

export function ThreadPane({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <aside aria-label="Thread" className="flex flex-col gap-2 border-t border-[var(--line)] p-3">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-2)]">{title}</h3>
      {children}
    </aside>
  );
}
