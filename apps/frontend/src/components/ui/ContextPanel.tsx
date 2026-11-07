import { useState, type ComponentType, type JSX, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export type Scope = "personal" | "workspace";

const iconButton =
  "size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

export function PanelIconButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }): JSX.Element {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={iconButton}>{children}</button>;
}

/** ~265px context panel: title row, optional scope switch, then content. */
export function ContextPanel({ title, actions, children, className = "" }: {
  title: string;
  actions?: ReactNode;
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <aside aria-label={title} className={`flex h-full w-[265px] min-w-[265px] shrink-0 flex-col overflow-hidden rounded-xl border border-[#e4e4e7] bg-white shadow-sm dark:border-zinc-800 dark:bg-[#121214] ${className}`.trim()}>
      <div className="flex shrink-0 items-center justify-between px-4 pb-2.5 pt-3.5">
        <h2 className="text-[14px] font-semibold tracking-tight text-[#0a0a0a] dark:text-zinc-100">{title}</h2>
        <div className="flex items-center gap-1">{actions}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">{children}</div>
    </aside>
  );
}

export function PanelNavItem({ icon: Icon, label, active = false, disabled = false, onClick, trailing }: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-current={active ? "page" : undefined}
      className={`flex h-[34px] w-full items-center gap-3 rounded-lg px-2.5 text-left text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${active ? "bg-[#e4e4e7] font-medium text-[#0a0a0a] dark:bg-zinc-800 dark:text-zinc-100" : "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"}`}>
      {Icon ? <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

/** Collapsible muted group ("Needs you", "Recents", "Channels"…) with its own empty line. */
export function PanelGroup({ label, emptyText, action, defaultOpen = true, children }: {
  label: string;
  emptyText?: string;
  action?: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const empty = children === undefined || children === null || (Array.isArray(children) && children.length === 0);
  return (
    <section aria-label={label} className="mt-4 flex flex-col first:mt-1">
      <div className="flex items-center justify-between px-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex w-fit items-center gap-1.5 rounded py-0.5 text-[12px] font-medium text-[#71717a] hover:text-[#0a0a0a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] dark:text-zinc-400 dark:hover:text-zinc-100">
          {label}
          <ChevronDown className={`size-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`} strokeWidth={2} aria-hidden="true" />
        </button>
        {action}
      </div>
      {open ? empty ? emptyText ? <p className="px-1 py-1 text-[12px] text-[#71717a] dark:text-zinc-500">{emptyText}</p> : null : <div className="flex flex-col gap-0.5 pt-1">{children}</div> : null}
    </section>
  );
}

/** Main card: full-height rounded card beside the context panel. */
export function MainCard({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#e4e4e7] bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`.trim()}>{children}</div>;
}

/** Centered empty state: muted icon, bold title, muted description, optional action. */
export function EmptyState({ icon: Icon, title, description, action }: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-1 select-none flex-col items-center justify-center p-8 text-center">
      {Icon ? <Icon className="mb-2 size-8 text-zinc-400 dark:text-zinc-500" strokeWidth={1.5} aria-hidden="true" /> : null}
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {description ? <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
