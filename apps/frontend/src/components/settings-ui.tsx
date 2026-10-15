/** Shared chrome for Settings surfaces — Capy token-based card. */
import type { JSX, ReactNode } from "react";

export function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)] overflow-hidden">
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  control,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3 px-4 border-b border-[var(--border-1)] last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--fg)] leading-snug">{label}</div>
        {description ? (
          <div className="text-[12px] text-[var(--muted-foreground-2)] leading-normal mt-0.5">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
