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
 *   - Lists real projects saved in workspace memory.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
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

export type MemoryNavId = "facts" | "sources" | "sessions";

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

async function apiJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

export function MemoryPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  counts: externalCounts,
  projects: externalProjects,
  selectedProject = "",
  onSelectProject,
  onSearch,
  onSync,
  className = "",
}: MemoryPanelProps): JSX.Element {
  const [internalProjects, setInternalProjects] = useState<MemoryPanelProject[]>([]);
  const [internalCounts, setInternalCounts] = useState<MemoryCounts>({
    facts: 0,
    sources: 0,
    sessions: 0,
  });

  const projects = externalProjects ?? internalProjects;
  const counts: MemoryCounts = {
    facts: externalCounts?.facts ?? internalCounts.facts,
    sources: externalCounts?.sources ?? internalCounts.sources,
    sessions: externalCounts?.sessions ?? internalCounts.sessions,
  };

  const loadData = useCallback(async () => {
    try {
      const [factsRes, sessionsRes, sourcesRes, projectsRes] = await Promise.all([
        apiJson<{ facts?: unknown[] }>("/api/memory/facts").catch(() => ({ facts: [] })),
        apiJson<{ sessions?: unknown[] }>("/api/memory/sessions").catch(() => ({ sessions: [] })),
        apiJson<{ sources?: unknown[] }>("/api/memory/sources").catch(() => ({ sources: [] })),
        apiJson<{ projects?: MemoryPanelProject[] }>("/api/memory/projects").catch(() => ({ projects: [] })),
      ]);

      const factsList = Array.isArray(factsRes.facts) ? factsRes.facts : [];
      const sessionsList = Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
      const sourcesList = Array.isArray(sourcesRes.sources) ? sourcesRes.sources : [];
      const projectsList = Array.isArray(projectsRes.projects) ? projectsRes.projects : [];

      setInternalProjects(projectsList);
      setInternalCounts({
        facts: factsList.length,
        sessions: sessionsList.length,
        sources: sourcesList.length,
      });
    } catch {
      // Fallback silently
    }
  }, []);

  useEffect(() => {
    if (!externalCounts || !externalProjects) {
      void loadData();
    }
  }, [externalCounts, externalProjects, loadData]);

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
