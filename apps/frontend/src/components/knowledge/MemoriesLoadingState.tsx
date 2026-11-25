import type { JSX } from "react";

export function MemoriesLoadingState(): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-5" role="status" aria-label="Loading memories" data-testid="memories-loading">
      {[3, 2].map((rows, group) => (
        <div key={group} aria-hidden="true" className="motion-safe:animate-pulse">
          <div className="mb-3 h-2.5 w-20 rounded-sm bg-[var(--secondary)]" />
          <div className="space-y-2">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row} className="rounded-xl border border-[var(--border-1)] bg-[var(--card)] px-4 py-4">
                <div className="h-3 w-full rounded-sm bg-[var(--secondary)]" />
                <div className="mt-2 h-3 w-4/5 rounded-sm bg-[var(--secondary)]" />
                <div className="mt-3 flex gap-2">
                  <div className="h-5 w-16 rounded-full bg-[var(--secondary)]" />
                  <div className="h-5 w-20 rounded-full bg-[var(--secondary)]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
