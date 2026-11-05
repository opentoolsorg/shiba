/**
 * MemoryPanel — Secondary contextual panel (~265px) for Durable Agent Memory.
 *
 * Header: "Memory" (14px/600) + Search action + Sync action.
 * Scope switch: Personal | Workspace.
 * Nav:
 *   - Banked Facts (Memory DO facts count)
 *   - Workspace Sources (private uploaded/noted memory sources count)
 *   - Recorded Sessions (Memory DO recorded sessions count)
 * Projects group:
 *   - Lists the projects passed in by the app. The panel never fetches.
 */
import type { JSX } from "react";
import {
  Brain,
  Database,
  FolderGit2,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  ContextPanel,
  PanelGroup,
  PanelIconButton,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";

export interface MemoryCounts {
  facts: number;
  sources: number;
  sessions: number;
}

export interface MemoryPanelProject {
  id: string;
  name: string;
}

export interface MemoryPanelProps {
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  counts?: Partial<MemoryCounts>;
  projects?: MemoryPanelProject[];
  selectedProject?: string;
  onSelectProject?: (projectId: string) => void;
  onSearch?: () => void;
  onSync?: () => void;
  className?: string;
}

export function MemoryPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  counts: providedCounts,
  projects = [],
  selectedProject = "",
  onSelectProject,
  onSearch,
  onSync,
  className = "",
}: MemoryPanelProps): JSX.Element {
  const counts: MemoryCounts = {
    facts: providedCounts?.facts ?? 0,
    sources: providedCounts?.sources ?? 0,
    sessions: providedCounts?.sessions ?? 0,
  };

  const countBadge = (val: number) => (
    <span className="ml-auto font-mono text-[11px] px-1.5 py-0.2 rounded-md text-[#71717a] dark:text-zinc-400">
      {val}
    </span>
  );

  return (
    <ContextPanel
      title="Memory"
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
      actions={
        <>
          {onSearch ? (
            <PanelIconButton label="Search memory" onClick={onSearch}>
              <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </PanelIconButton>
          ) : null}
          {onSync ? (
            <PanelIconButton label="Sync memory" onClick={onSync}>
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </PanelIconButton>
          ) : null}
        </>
      }
    >
      {/* Primary Nav Sections */}
      <div className="flex flex-col gap-0.5">
        <PanelNavItem
          icon={Brain}
          label="Banked Facts"
          active={active === "facts"}
          onClick={() => onSelect("facts")}
          trailing={countBadge(counts.facts)}
        />
        <PanelNavItem
          icon={Database}
          label="Workspace Sources"
          active={active === "sources"}
          onClick={() => onSelect("sources")}
          trailing={countBadge(counts.sources)}
        />
        <PanelNavItem
          icon={History}
          label="Recorded Sessions"
          active={active === "sessions"}
          onClick={() => onSelect("sessions")}
          trailing={countBadge(counts.sessions)}
        />
      </div>

      {/* Projects / Collections */}
      <PanelGroup
        label="Projects"
        emptyText="No projects saved"
        defaultOpen={true}
      >
        {projects.map((proj) => {
          const isSelected = selectedProject === proj.id;
          return (
            <PanelNavItem
              key={proj.id}
              icon={FolderGit2}
              label={proj.name}
              active={isSelected}
              onClick={() => onSelectProject?.(isSelected ? "" : proj.id)}
            />
          );
        })}
      </PanelGroup>
    </ContextPanel>
  );
}
