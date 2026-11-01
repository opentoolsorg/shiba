import type { ReactNode } from "react";
import { ChevronDown, CircleDashed } from "lucide-react";

/** Shared chrome for the activity, analytics, and MCP views. */
export function ViewHeader({ section, view, count, children, leading }: { section: string; view: string; count?: string; children?: ReactNode; leading?: ReactNode }) {
  return (
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--chrome)] px-6 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--muted-foreground-2)]">
        {leading}<span>Personal</span><span aria-hidden="true">&gt;</span><span>{section}</span><span aria-hidden="true">&gt;</span>
        <h2 className="font-sans text-sm font-medium text-[var(--fg)]">{view}</h2>
        {count ? <span className="rounded-full bg-[var(--section)] px-2 py-0.5 text-xs tabular-nums">{count}</span> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function ViewGroup({ title, count, children, dotClass }: { title: string; count?: number; children: ReactNode; dotClass?: string }) {
  return (
    <details open className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="size-3.5 -rotate-90 text-[var(--icon-muted)] group-open:rotate-0" />
        <span aria-hidden="true" className={`size-2 rounded-full border border-[var(--border-3)] ${dotClass ?? ""}`} />
        {title}
        {count !== undefined ? <span className="font-normal tabular-nums text-[var(--muted-foreground-2)]">{count}<span className="sr-only"> {count === 1 ? "item" : "items"}</span></span> : null}
      </summary>
      {children}
    </details>
  );
}

export function ViewEmpty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-32 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-[13px] text-[var(--muted-foreground-2)]"><CircleDashed aria-hidden="true" className="size-6 text-[var(--icon-muted)]" /><p>{children}</p></div>;
}

export const viewButtonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--secondary)] px-3 text-[13px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--secondary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
