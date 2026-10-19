import type { JSX, ReactNode } from "react";

/** Serif page title + quiet explanation. Children sit on the right (actions, counts). */
export function PageHeader({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[22px] leading-none text-[var(--fg)]">{title}</h2>
        {detail ? (
          <p className="mt-1.5 text-xs text-[var(--muted-foreground-2)] max-w-2xl">{detail}</p>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 border border-dashed border-[var(--border-1)] bg-[var(--card)] px-6 py-10 text-center">
      <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
      <p className="max-w-sm text-xs text-[var(--muted-foreground-2)]">{detail}</p>
    </div>
  );
}

export function StatusNotice({
  tone,
  children,
}: {
  tone: "ok" | "err" | "info";
  children: ReactNode;
}): JSX.Element {
  const toneClass =
    tone === "err"
      ? "text-[var(--destructive)] bg-[var(--destructive-soft)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]"
      : tone === "ok"
        ? "text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] border-[color-mix(in_oklch,var(--success)_30%,transparent)]"
        : "text-[var(--muted-foreground-1)] bg-[var(--card)] border-[var(--border-1)]";
  return (
    <div role={tone === "err" ? "alert" : "status"} className={`border px-3 py-2 text-xs ${toneClass}`}>
      {children}
    </div>
  );
}

/** Reserved-height bars so a loaded card does not jump the thread. */
export function CardSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex min-h-[88px] flex-col gap-2" role="status" aria-busy="true" aria-label={label}>
      <div className="skeleton h-4 w-36" />
      <div className="skeleton h-3 w-full" />
      <div className="skeleton h-3 w-2/3" />
    </div>
  );
}

export function SkeletonLines({ rows = 3 }: { rows?: number }): JSX.Element {
  const widths = ["100%", "86%", "72%", "92%", "64%"];
  return (
    <div className="flex flex-col gap-2" aria-hidden="true" data-testid="skeleton">
      {widths.slice(0, rows).map((width) => (
        <div key={width} className="skeleton h-3" style={{ width }} />
      ))}
    </div>
  );
}
