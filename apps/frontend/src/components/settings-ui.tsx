/** Shared chrome for Settings surfaces — token-based card and rows. */
import type { ComponentType, JSX, ReactNode } from "react";

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

/** Structured card row: icon, title, description on the left; control on the right. */
export function SettingRow({
  icon: Icon,
  title,
  description,
  control,
  children,
  className = "",
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`flex items-center justify-between gap-4 border-b border-[#e4e4e7] dark:border-zinc-800 px-4 py-3.5 last:border-b-0 ${className}`.trim()}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {Icon ? (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f4f4f5] dark:bg-zinc-800 text-[#71717a] dark:text-zinc-400">
            <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100">{title}</div>
          {description ? (
            <div className="text-[12px] text-[#71717a] dark:text-zinc-400 mt-0.5">{description}</div>
          ) : null}
          {children}
        </div>
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}
