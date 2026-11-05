import { type JSX, useState } from "react";
import { ChevronRight, Clock, LayoutGrid, List, Network, Search } from "lucide-react";
import { WorkStatusIcon, workListGroup } from "./WorkListView";
import type { WorkHeaderViewMode } from "./WorkHeader";

export type WorkScope = "personal" | "workspace";

export interface WorkLeftPanelTask {
  id: string;
  title: string;
  /** Any server/run status; mapped onto the five planning groups for the status circle. */
  status: string;
}

export interface WorkLeftPanelProps {
  scope: WorkScope;
  onScopeChange: (scope: WorkScope) => void;
  view: WorkHeaderViewMode;
  onViewChange: (view: WorkHeaderViewMode) => void;
  needsYou: readonly WorkLeftPanelTask[];
  assignedToMe: readonly WorkLeftPanelTask[];
  /** Open (not done) tasks only. */
  everything: readonly WorkLeftPanelTask[];
  selectedId?: string | null;
  onOpenTask: (id: string) => void;
  onSearch?: () => void;
  className?: string;
}

const NAV = [
  { id: "list", label: "List", icon: List },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "timeline", label: "Timeline", icon: Clock },
  { id: "organization", label: "Organization", icon: Network },
] as const;

const SECTIONS = [
  { id: "needsYou", label: "Needs you", empty: "Nothing needs you" },
  { id: "assignedToMe", label: "Assigned to me", empty: "Nothing assigned to you" },
  { id: "everything", label: "Everything", empty: "No open tasks" },
] as const;

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

export function WorkLeftPanel({
  scope,
  onScopeChange,
  view,
  onViewChange,
  needsYou,
  assignedToMe,
  everything,
  selectedId,
  onOpenTask,
  onSearch,
  className = "",
}: WorkLeftPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const lists = { needsYou, assignedToMe, everything };
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <aside aria-label="Work" className={`shiba-context-panel text-[var(--fg)] ${className}`.trim()}>
      <div className="flex shrink-0 items-center justify-between px-1">
        <h2 className="text-[14px] font-semibold tracking-tight">Work</h2>
        {onSearch ? (
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search tasks"
            className={`flex size-7 items-center justify-center rounded-md text-[var(--icon-muted)] hover:bg-[var(--shiba-hover)] hover:text-[var(--fg)] ${focusRing}`}
          >
            <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <fieldset aria-label="Work scope" className="shiba-segmented m-0 min-w-0 shrink-0 border-0">
        {(["personal", "workspace"] as const).map((id) => (
          <button key={id} type="button" aria-pressed={scope === id} onClick={() => onScopeChange(id)} className={focusRing}>
            {id === "personal" ? "Personal" : "Workspace"}
          </button>
        ))}
      </fieldset>

      <nav aria-label="Work pages" className="flex shrink-0 flex-col gap-0.5">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onViewChange(item.id)}
            className={`shiba-nav-item ${focusRing}`}
          >
            <item.icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-col gap-1">
        {SECTIONS.map((section) => {
          const rows = lists[section.id];
          const open = !collapsed.has(section.id);
          const listId = `work-left-${section.id}`;
          return (
            <section key={section.id} aria-label={section.label}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggle(section.id)}
                className={`shiba-label flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] ${focusRing}`}
              >
                <ChevronRight aria-hidden="true" className={`size-3.5 motion-safe:transition-transform ${open ? "rotate-90" : ""}`} />
                <span>{section.label}</span>
              </button>
              {open ? (
                <div id={listId}>
                  {rows.length === 0 ? (
                    <p className="px-2.5 py-1.5 text-[12px] text-[var(--muted-foreground-3)]">{section.empty}</p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {rows.map((task) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            aria-current={task.id === selectedId ? "true" : undefined}
                            data-active={task.id === selectedId ? "true" : undefined}
                            onClick={() => onOpenTask(task.id)}
                            className={`shiba-nav-item ${focusRing}`}
                          >
                            <WorkStatusIcon group={workListGroup(task.status)} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate">{task.title || "Untitled task"}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
