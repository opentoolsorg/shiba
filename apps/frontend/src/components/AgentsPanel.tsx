import { CheckSquare, ChevronRight, Network, Pin, Plus, Search, Sliders, X } from "lucide-react";
import { type JSX, useId, useState } from "react";
import type { WebThread } from "../agent-threads";
import { threadAgentId } from "../agent-threads";
import { employeeRole, employeeRoleLabel } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";
import { AgentThreadList, agentRunState, type ThreadRunState } from "./AgentThreadList";
import type { CustomAgentWire } from "./CustomAgentsView";
import { ContextPanel, PanelIconButton, PanelNavItem, type Scope } from "./ui/ContextPanel";

const DEFAULT_AGENT_ID = "shiba";
const PINNED_KEY = "shiba.agents.pinned";

function readPinned(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePinned(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    // Pins are a per-viewer convenience; storage may be unavailable.
  }
}

export interface AgentsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  agents?: CustomAgentWire[];
  threads?: WebThread[];
  /** Live run state per thread id (e.g. the streaming session); overrides session metadata. */
  threadStates?: Record<string, ThreadRunState>;
  onNewThread?: (agentId?: string) => void;
  onSelectThread?: (id: string) => void;
  onSelectAgent?: (id: string) => void;
  onNewAgent?: () => void;
  /** Opens the agent catalog from the empty state; falls back to onNewAgent. */
  onOpenCatalog?: () => void;
  ownerName?: string;
  workspaceName?: string;
  className?: string;
}

interface AgentRow {
  id: string;
  name: string;
  subtitle: string;
  agent?: CustomAgentWire;
  threads: WebThread[];
}

const rowAction =
  "flex size-6 shrink-0 items-center justify-center rounded text-[#71717a] hover:bg-[#d4d4d8] hover:text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100";

/** Secondary panel for Agents: the default chief of staff plus every custom agent, each with its threads. */
export function AgentsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  agents = [],
  threads = [],
  threadStates,
  onNewThread,
  onSelectThread,
  onSelectAgent,
  onNewAgent,
  onOpenCatalog,
  ownerName,
  workspaceName,
  className = "",
}: AgentsPanelProps): JSX.Element {
  const listId = useId();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState<string[]>(readPinned);

  const togglePin = (agentId: string) => {
    setPinned((prev) => {
      const next = prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId];
      writePinned(next);
      return next;
    });
  };

  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  // Unbound and orphaned sessions belong to the default agent; "default" always exists server-side.
  const defaultThreads = threads.filter((thread) => !knownAgentIds.has(threadAgentId(thread)));
  if (!defaultThreads.some((thread) => thread.id === "default")) {
    defaultThreads.push({ id: "default", name: "Default session", agentName: "", updatedAt: 0 });
  }
  const byRecent = (a: WebThread, b: WebThread) => b.updatedAt - a.updatedAt;

  const defaultRow: AgentRow = {
    id: DEFAULT_AGENT_ID,
    name: "Shiba",
    subtitle:
      scope === "workspace"
        ? workspaceName
          ? `${workspaceName} · Workspace`
          : "Workspace"
        : `${ownerName ?? "You"} · You`,
    threads: defaultThreads.sort(byRecent),
  };
  const customRows: AgentRow[] = agents
    .map((agent) => ({
      id: agent.id,
      name: agent.config.name,
      subtitle: [
        employeeRoleLabel(employeeRole(agent.slug, agent.config.roleTemplateId)),
        agent.config.harness,
      ]
        .filter(Boolean)
        .join(" · "),
      agent,
      threads: threads
        .filter((thread) => thread.id !== "default" && threadAgentId(thread) === agent.id)
        .sort(byRecent),
    }))
    .sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)));

  const query = searchQuery.trim().toLowerCase();
  const matches = (row: AgentRow) =>
    !query ||
    row.name.toLowerCase().includes(query) ||
    row.subtitle.toLowerCase().includes(query) ||
    (row.agent?.slug.toLowerCase().includes(query) ?? false);
  const rows = [defaultRow, ...customRows].filter(matches);

  const openThread = (id: string) => {
    onSelectThread?.(id);
    onSelect(id);
  };

  const actions = (
    <>
      <PanelIconButton
        label={searchOpen ? "Close search" : "Search agents"}
        onClick={() => {
          setSearchOpen((prev) => !prev);
          if (searchOpen) setSearchQuery("");
        }}
      >
        {searchOpen ? (
          <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
        )}
      </PanelIconButton>
      <PanelIconButton label="New agent" onClick={onNewAgent}>
        <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </PanelIconButton>
    </>
  );

  return (
    <ContextPanel
      title="Agents"
      actions={actions}
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
    >
      {searchOpen ? (
        <div className="mb-2 shrink-0 px-1">
          <div className="relative flex items-center">
            <Search
              className="absolute left-2 size-3.5 text-[#71717a] dark:text-zinc-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents…"
              aria-label="Filter agents"
              // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
              autoFocus
              className="h-7 w-full rounded-md border border-[#e4e4e7] bg-white pl-7 pr-2 text-[12px] text-[#0a0a0a] placeholder-[#71717a] focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-1 flex-col overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-[#71717a] dark:text-zinc-500">
            No matching agents
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5" aria-label="Agents">
          {rows.map((row) => {
            const isDefault = row.id === DEFAULT_AGENT_ID;
            const isExpanded =
              expanded[row.id] ?? (isDefault || row.threads.some((thread) => thread.id === active));
            const status = agentRunState(row.threads, threadStates);
            const isPinned = pinned.includes(row.id);
            const threadsId = `${listId}-${row.id}`;
            return (
              <li key={row.id} className="flex flex-col">
                <div
                  className={`group relative flex items-center gap-0.5 rounded-lg px-2 py-1.5 transition-colors ${
                    active === row.id
                      ? "bg-[#e4e4e7] dark:bg-zinc-800"
                      : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <button
                    type="button"
                    aria-current={active === row.id ? "page" : undefined}
                    onClick={() => {
                      if (row.agent) {
                        onSelectAgent?.(row.id);
                        onSelect(row.id);
                        return;
                      }
                      const latest = row.threads[0];
                      if (latest) openThread(latest.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
                  >
                    <AgentAvatar
                      id={isDefault ? DEFAULT_AGENT_ID : (row.agent?.slug ?? row.id)}
                      name={row.name}
                      mascotPreset={row.agent?.config.mascotPreset}
                      role={
                        row.agent
                          ? employeeRole(row.agent.slug, row.agent.config.roleTemplateId)
                          : undefined
                      }
                      size={28}
                      status={status}
                      decorative
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100">
                        {row.name}
                      </span>
                      <span className="block truncate text-[11px] text-[#71717a] dark:text-zinc-400">
                        {row.subtitle}
                      </span>{" "}
                    </span>
                  </button>
                  {row.agent ? (
                    <button
                      type="button"
                      aria-label={`${isPinned ? "Unpin" : "Pin"} ${row.name}`}
                      title={`${isPinned ? "Unpin" : "Pin"} ${row.name}`}
                      aria-pressed={isPinned}
                      onClick={() => togglePin(row.id)}
                      className={`${rowAction} ${isPinned ? "" : "sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"}`}
                    >
                      <Pin
                        className={`size-3.5 ${isPinned ? "fill-current" : ""}`}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`New thread with ${row.name}`}
                    title={`New thread with ${row.name}`}
                    onClick={() => onNewThread?.(row.agent?.id)}
                    className={rowAction}
                  >
                    <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.name}`}
                    title={`${isExpanded ? "Collapse" : "Expand"} ${row.name}`}
                    aria-expanded={isExpanded}
                    aria-controls={isExpanded ? threadsId : undefined}
                    onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !isExpanded }))}
                    className={rowAction}
                  >
                    <ChevronRight
                      className={`size-3.5 motion-safe:transition-transform motion-safe:duration-150 ${isExpanded ? "rotate-90" : ""}`}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                {isExpanded ? (
                  <AgentThreadList
                    id={threadsId}
                    agentName={row.name}
                    threads={row.threads}
                    activeId={active}
                    threadStates={threadStates}
                    onSelect={openThread}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>

        {agents.length === 0 && !query ? (
          <div className="mt-3 rounded-xl border border-dashed border-[#e4e4e7] px-3 py-6 text-center dark:border-zinc-800">
            <AgentAvatar
              id="support-triage"
              name="Your next teammate"
              size={72}
              decorative
              className="mx-auto"
            />
            <h3 className="mt-3 text-[14px] font-semibold text-[#0a0a0a] dark:text-zinc-100">
              Make room for good work.
            </h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#71717a] dark:text-zinc-400">
              A teammate for the work you love. And the work you don’t.
            </p>
            <button
              type="button"
              onClick={() => (onOpenCatalog ?? onNewAgent)?.()}
              className="mt-4 min-h-11 w-full rounded-lg bg-[#0a0a0a] px-3 text-[12px] font-medium text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:focus-visible:ring-offset-zinc-900"
            >
              Hire your first teammate
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-[#e4e4e7] pt-2 dark:border-zinc-800">
        <PanelNavItem
          icon={Sliders}
          label="Tool policy"
          active={active === "employee-tools"}
          onClick={() => onSelect("employee-tools")}
        />
        <PanelNavItem
          icon={Network}
          label="Swarm"
          active={active === "swarm"}
          onClick={() => onSelect("swarm")}
        />
        <PanelNavItem
          icon={CheckSquare}
          label="Tasks"
          active={active === "tasks"}
          onClick={() => onSelect("tasks")}
        />
      </div>
    </ContextPanel>
  );
}
