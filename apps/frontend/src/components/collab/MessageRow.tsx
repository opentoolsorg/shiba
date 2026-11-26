import type { JSX, ReactNode } from "react";

export function MessageRow({ id, agent, children }: { id?: string; agent: boolean; children: ReactNode }): JSX.Element {
  return (
    <article
      id={id}
      tabIndex={id ? -1 : undefined}
      className={`min-w-0 border-l-2 p-3 ${agent ? "border-[var(--navy)] bg-[var(--panel-2)]" : "border-[var(--line)]"}`}
    >
      {children}
    </article>
  );
}
