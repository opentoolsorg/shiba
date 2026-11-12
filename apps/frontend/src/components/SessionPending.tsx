import { useEffect, useState, type JSX } from "react";

/** Shared first paint for the router and identity gate; no private data or fake progress. */
export function SessionPending({ onRetry }: { onRetry?: () => void } = {}): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="flex h-dvh bg-[var(--bg)] font-sans text-[var(--fg)]" role="region" aria-busy="true" aria-label="Loading workspace">
      <aside aria-hidden="true" className="hidden w-16 shrink-0 flex-col items-center gap-6 border-r border-[var(--border-1)] bg-[var(--chrome)] py-5 sm:flex">
        {[0, 1, 2, 3].map((item) => <div key={item} className="size-8 rounded bg-[var(--secondary)]" />)}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col p-5 sm:p-8">
        <p role="status" className="text-sm text-[var(--muted-foreground-2)]">{slow ? "Your session check is taking longer than usual…" : "Checking your session…"}</p>
        {slow && onRetry ? <button type="button" onClick={onRetry} className="mt-3 min-h-11 w-fit rounded border border-[var(--border-1)] px-4 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">Retry session check</button> : null}
        <div aria-hidden="true" className="mt-8 flex min-h-0 flex-1 flex-col gap-6">
          <div className="h-9 w-48 max-w-full bg-[var(--secondary)]" />
          <div className="h-32 w-full max-w-3xl border border-[var(--border-1)] bg-[var(--card)]" />
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((item) => <div key={item} className="h-40 border border-[var(--border-1)] bg-[var(--card)] p-4"><div className="h-4 w-20 bg-[var(--secondary)]" /><div className="mt-5 h-16 bg-[var(--section)]" /></div>)}
          </div>
        </div>
      </main>
    </div>
  );
}
