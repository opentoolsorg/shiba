import { ChevronRight, PanelLeft, Plus, Search } from "lucide-react";
import type { JSX } from "react";
import { Tooltip } from "./Tooltip";

export type WorkHeaderViewMode = "list" | "board" | "timeline" | "organization";

export interface WorkHeaderProps {
  crumbs: string[];
  countLabel?: string;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onSearch(): void;
  /** Whether the task filter input (id `work-search`) is currently shown. */
  searchOpen?: boolean;
  onNewTask(): void;
  activeView?: WorkHeaderViewMode;
  onViewChange?: (view: WorkHeaderViewMode) => void;
  className?: string;
}

/**
 * Top bar (48px) for the Work main card:
 * Left: sidebar toggle icon button, breadcrumb crumbs (Workspace > Work > List [> task title]), and optional count label (e.g. "0 open").
 * Center: visible segmented view switcher when sidebar is collapsed or on screens below lg.
 * Right: search icon button and "New task" button with plus icon.
 */
export function WorkHeader({
  crumbs,
  countLabel,
  sidebarCollapsed = false,
  onToggleSidebar,
  onSearch,
  searchOpen = false,
  onNewTask,
  activeView,
  onViewChange,
  className = "",
}: WorkHeaderProps): JSX.Element {
  return (
    <header
      className={`min-h-[48px] w-full px-4 py-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 select-none shrink-0 ${className}`.trim()}
    >
      {/* Left: sidebar toggle + breadcrumbs */}
      <div className="flex items-center gap-2.5 min-w-0">
        <Tooltip
          content={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          shortcut="⌘B"
          side="bottom"
        >
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            className="hidden size-7 rounded-md lg:flex items-center justify-center text-[var(--icon-muted,#71717a)] hover:text-[var(--fg,#0a0a0a)] hover:bg-[var(--secondary,rgba(0,0,0,0.05))] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
          >
            <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>

        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
          <ol className="flex items-center gap-1.5 min-w-0">
            {crumbs.map((crumb, idx) => {
              const isLast = idx === crumbs.length - 1;
              return (
                <li key={`${crumb}-${idx}`} className="flex items-center gap-1.5 min-w-0">
                  {idx > 0 ? (
                    <ChevronRight
                      className="size-3.5 text-[var(--muted-foreground-3,#a5a69b)] shrink-0"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span
                    className={
                      isLast
                        ? "max-w-[12rem] sm:max-w-[20rem] text-[14px] font-medium text-[var(--fg,#0a0a0a)] truncate"
                        : "text-[14px] text-[var(--muted-foreground-2,#71717a)] truncate"
                    }
                    title={crumb}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb}
                  </span>
                </li>
              );
            })}
          </ol>

          {countLabel ? (
            <span className="text-[12px] text-[var(--muted-foreground-3,#a5a69b)] select-none shrink-0 font-normal ml-1">
              {countLabel}
            </span>
          ) : null}
        </nav>
      </div>

      {/* Center: view switcher shown when sidebarCollapsed or below lg */}
      {activeView && onViewChange ? (
        <fieldset
          aria-label="Work views"
          className={`${sidebarCollapsed ? "flex" : "flex lg:hidden"} order-last w-full sm:order-none sm:w-auto items-center gap-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-0.5 border border-zinc-200/60 dark:border-zinc-700/60`}
        >
          {(["list", "board", "timeline", "organization"] as const).map((mode) => {
            const label = mode.charAt(0).toUpperCase() + mode.slice(1);
            const isActive = activeView === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={isActive}
                onClick={() => onViewChange(mode)}
                className={`min-h-11 flex-1 sm:flex-none lg:min-h-0 px-2 py-0.5 text-xs font-medium rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
                  isActive
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-2xs"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </fieldset>
      ) : null}

      {/* Right: search + new task button */}
      <div className="flex items-center gap-2 shrink-0">
        <Tooltip content="Filter tasks" side="bottom">
          <button
            type="button"
            onClick={onSearch}
            aria-label="Filter tasks"
            aria-expanded={searchOpen}
            aria-controls="work-search"
            className="size-11 lg:size-7 rounded-md flex items-center justify-center text-[var(--icon-muted,#71717a)] hover:text-[var(--fg,#0a0a0a)] hover:bg-[var(--secondary,rgba(0,0,0,0.05))] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
          >
            <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>

        <button
          type="button"
          onClick={onNewTask}
          aria-label="New task"
          className="h-11 lg:h-8 px-2.5 rounded-lg bg-[var(--primary,#0a0a0a)] text-[var(--primary-text,#fff)] hover:opacity-90 text-[13px] font-medium flex items-center gap-1.5 transition-opacity shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[var(--ring,#a1a1aa)]"
        >
          <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
          <span className="hidden sm:inline">New task</span>
        </button>
      </div>
    </header>
  );
}
