import { CheckSquare, ChevronRight, Command, MessageSquare, Network, Pin, Plus, Search, Sliders, X } from "lucide-react";
import { type JSX, useId, useState } from "react";
import type { WebThread } from "../agent-threads";
import { threadAgentId } from "../agent-threads";
import { EMPLOYEE_TEMPLATES, employeeRole, employeeRoleLabel } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";
import { AgentThreadList, agentRunState, type ThreadRunState } from "./AgentThreadList";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { SessionItem } from "./SessionsSidebar";
import { ContextPanel, PanelGroup, PanelIconButton, PanelNavItem, type Scope } from "./ui/ContextPanel";

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
  runs?: SessionItem[];
  /** Live run state per thread id (e.g. the streaming session); overrides session metadata. */
  threadStates?: Record<string, ThreadRunState>;
  onNewThread?: (agentId?: string) => void;
  /** Why no thread can be started yet; New thread buttons stay disabled until it clears. */
  newThreadDisabledReason?: string;
  onSelectThread?: (id: string) => void;
  onSelectRun?: (id: string) => void;
  onNewChat?: () => void;
  onSearchAll?: () => void;
  onSelectAgent?: (id: string) => void;
  /** Opens this bot's page with its own panel, instead of leaving for the roster. */
  onOpenAgent?: (id?: string) => void;
  onNewAgent?: () => void;
  ownerName?: string;
  workspaceName?: string;
  /** The bot registry is still loading; rows appear as placeholders rather than an empty Shiba row. */
  loading?: boolean;
  /** The bot registry failed, so an empty list is not the same as "no bots". */
  error?: string | null;
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
  "flex size-7 shrink-0 items-center justify-center rounded text-[var(--muted-foreground-2)] hover:bg-[var(--card-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]";

/** Secondary panel for Agents: the default chief of staff plus every custom agent, each with its threads. */
export function AgentsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  agents = [],
  threads = [],
  runs = [],
  threadStates,
  onNewThread,
  runs = [],
  onSelectRun,
  onNewChat,
  onSearchAll,
  onLoadMoreRuns,
  newThreadDisabledReason,
  onSelectThread,
  onSelectRun,
  onNewChat,
  onSearchAll,
  onSelectAgent,
  onOpenAgent,
  onNewAgent,
  ownerName,
  workspaceName,
  loading = false,
  error = null,
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
  const orphanThreads = loading ? [] : threads.filter((thread) => {
    const agentId = threadAgentId(thread);
    return agentId !== "" && !knownAgentIds.has(agentId);
  });
  const defaultThreads = threads.filter((thread) => !threadAgentId(thread));
  if (!threadsLoading && !defaultThreads.some((thread) => thread.id === "default")) {
    defaultThreads.push({ id: "default", name: "Default session", agentName: "", updatedAt: 0 });
  }
  const byRecent = (a: WebThread, b: WebThread) => b.updatedAt - a.updatedAt;

  const defaultRow: AgentRow = {
    id: DEFAULT_AGENT_ID,
    name: "Shiba",
    subtitle:
      scope === "workspace"
        ? workspaceName
          ? `${workspaceName} · Workspace chief of staff`
          : "Workspace chief of staff"
        : `${ownerName ?? "You"} · Personal chief of staff`,
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
    .sort((a, b) => {
      const roleOrder = (row: AgentRow) => {
        const role = employeeRole(row.agent?.slug, row.agent?.config.roleTemplateId);
        return role === "custom" ? EMPLOYEE_TEMPLATES.length : EMPLOYEE_TEMPLATES.findIndex((template) => template.id === role);
      };
      return roleOrder(a) - roleOrder(b);
    });

  const query = searchQuery.trim().toLowerCase();
  const matchesIdentity = (row: AgentRow) =>
    !query ||
    row.name.toLowerCase().includes(query) ||
    row.subtitle.toLowerCase().includes(query) ||
    (row.agent?.slug.toLowerCase().includes(query) ?? false);
  const matchingThreads = (row: AgentRow) =>
    query ? row.threads.filter((thread) => thread.name.toLowerCase().includes(query)) : row.threads;
  const matchingRows = [defaultRow, ...customRows].filter((row) => matchesIdentity(row) || matchingThreads(row).length > 0);
  const rows = [
    ...matchingRows.filter((row) => row.id === DEFAULT_AGENT_ID),
    ...matchingRows.filter((row) => row.agent && pinned.includes(row.id)),
    ...matchingRows.filter((row) => row.id !== DEFAULT_AGENT_ID && !(row.agent && pinned.includes(row.id))),
  ];
  const sortedRuns = [...runs].sort((a, b) => b.updatedAt - a.updatedAt);
  const recentRuns = sortedRuns.slice(0, 8);
  const selectedRun = sortedRuns.find((run) => run.id === active);
  const visibleRuns = selectedRun && !recentRuns.some((run) => run.id === selectedRun.id)
    ? [selectedRun, ...recentRuns.slice(0, 7)]
    : recentRuns;

  const openThread = (id: string) => {
    onSelectThread?.(id);
    onSelect(id);
  };

  const actions = (
    <>
      {onNewChat ? (
        <PanelIconButton label="New chat" onClick={onNewChat}>
          <MessageSquare className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </PanelIconButton>
      ) : null}
      {onSearchAll ? (
        <PanelIconButton label="Search all" onClick={onSearchAll}>
          <Command className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </PanelIconButton>
      ) : null}
      <PanelIconButton
        label={searchOpen ? "Close search" : "Search employees"}
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
      <PanelIconButton label="New employee" onClick={onNewAgent}>
        <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </PanelIconButton>
    </>
  );

  return (
    <ContextPanel
      title="Employees"
      actions={actions}
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
    >
      {searchOpen ? (
        <div className="mb-2 shrink-0 px-1">
          <div className="relative flex items-center">
            <Search
              className="absolute left-2 size-3.5 text-[var(--muted-foreground-2)]"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search employees…"
              aria-label="Filter employees"
              // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
              autoFocus
              className="h-9 w-full rounded-md border border-[var(--border-1)] bg-[var(--input)] pl-7 pr-2 text-[12px] text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] focus:border-[var(--ring)] focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-1 flex-col overflow-y-auto">
        {threadsLoading ? <p role="status" aria-live="polite" className="px-2 py-2 text-xs text-[var(--muted-foreground-2)]">Loading threads…</p> : null}
        {loading && agents.length === 0 ? (
          <ul aria-label="Loading employees" aria-busy="true" className="flex flex-col gap-1 px-2 py-1">
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex items-center gap-2.5 py-1.5" aria-hidden="true">
                <span className="size-7 shrink-0 animate-pulse bg-[#e4e4e7] dark:bg-zinc-800" />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="h-2.5 w-24 animate-pulse bg-[#e4e4e7] dark:bg-zinc-800" />
                  <span className="h-2 w-16 animate-pulse bg-[#f4f4f5] dark:bg-zinc-800/60" />
                </span>
              </li>
            ))}
            <li className="sr-only">Loading employees…</li>
          </ul>
        ) : null}
        {error && agents.length === 0 ? (
          <p role="alert" className="px-2 py-2 text-[12px] text-[#b91c1c] dark:text-red-400">
            Employees couldn’t load: {error}
          </p>
        ) : null}
        {rows.length === 0 && !loading && !error ? (
          <p className="px-2 py-3 text-center text-[12px] text-[#71717a] dark:text-zinc-500">
            No matching employees
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5" aria-label="Agents">
          {rows.map((row, index) => {
            const isDefault = row.id === DEFAULT_AGENT_ID;
            const role = row.agent ? employeeRole(row.agent.slug, row.agent.config.roleTemplateId) : null;
            const isPinned = Boolean(row.agent && pinned.includes(row.id));
            const previousRow = rows[index - 1];
            const previousAgent = previousRow?.agent && !pinned.includes(previousRow.id) ? previousRow.agent : undefined;
            const previousRole = previousAgent
              ? employeeRole(previousAgent.slug, previousAgent.config.roleTemplateId)
              : null;
            const showPinnedHeading = isPinned && !rows.slice(0, index).some((candidate) => candidate.agent && pinned.includes(candidate.id));
            const showRoleHeading = !isPinned && role !== null && role !== previousRole;
            const identityMatches = matchesIdentity(row);
            const threadMatches = matchingThreads(row);
            const isExpanded = expanded[row.id] ?? (
              isDefault ||
              row.threads.some((thread) => thread.id === active) ||
              (Boolean(query) && row.threads.length > 0)
            );
            const visibleThreads = query && !identityMatches ? threadMatches : row.threads;
            const status = agentRunState(row.threads, threadStates);
            const threadsId = `${listId}-${row.id}`;
            return (
              <li key={row.id} className="flex flex-col">
                {showPinnedHeading ? <h3 className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground-2)]">Pinned</h3> : null}
                {showRoleHeading ? <h3 className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground-2)]">{employeeRoleLabel(role)}</h3> : null}
                <div
                  className={`group relative flex items-center gap-0.5 rounded-lg px-2 py-1.5 transition-colors ${
                    active === row.id
                      ? "bg-[var(--card-hover)]"
                      : "hover:bg-[var(--card-hover)]"
                  }`}
                >
                  <button
                    type="button"
                    aria-current={active === row.id ? "page" : undefined}
                    onClick={() => {
                      if (row.id.startsWith("unavailable:")) {
                        const latest = row.threads[0];
                        if (latest) openThread(latest.id);
                        return;
                      }
                      if (onOpenAgent) {
                        onOpenAgent(row.agent?.id);
                        onSelect(row.id);
                        return;
                      }
                      if (row.agent) {
                        onSelectAgent?.(row.id);
                        onSelect(row.id);
                        return;
                      }
                      const latest = row.threads[0];
                      if (latest) openThread(latest.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                  >
                    <AgentAvatar
                      id={isDefault ? DEFAULT_AGENT_ID : row.id}
                      name={row.name}
                      mascotPreset={row.agent?.config.mascotPreset}
                      avatar={row.agent?.config.avatar}
                      look={row.agent?.config.look}
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
                      <span className="block truncate text-[13px] font-medium text-[var(--fg)]">
                        {row.name}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--muted-foreground-2)]">
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
                  {!row.id.startsWith("unavailable:") ? (
                    <button
                      type="button"
                      aria-label={`New thread with ${row.name}`}
                      title={newThreadDisabledReason ?? `New thread with ${row.name}`}
                      disabled={Boolean(newThreadDisabledReason)}
                      onClick={() => onNewThread?.(row.agent?.id)}
                      className={`${rowAction} disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.name}`}
                    title={`${isExpanded ? "Collapse" : "Expand"} ${row.name}`}
                    aria-expanded={isExpanded}
                    aria-controls={isExpanded ? threadsId : undefined}
                    disabled={revealMatches}
                    onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !isExpanded }))}
                    className={rowAction}
                  >
                    {!isExpanded && row.threads.length > 0 ? (
                      <span className="text-[10px] tabular-nums" aria-hidden="true">
                        {row.threads.length}
                      </span>
                    ) : null}
                    <ChevronRight
                      className={`size-3.5 motion-safe:transition-transform motion-safe:duration-150 ${isExpanded ? "rotate-90" : ""}`}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                {isExpanded && !threadsLoading ? (
                  <AgentThreadList
                    id={threadsId}
                    agentName={row.name}
                    threads={visibleThreads}
                    activeId={active}
                    threadStates={threadStates}
                    onSelect={openThread}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {runs.length > 0 ? (
          <PanelGroup label="Recent runs">
            {visibleRuns.map((run) => (
              <PanelNavItem
                key={run.id}
                icon={CheckSquare}
                label={run.title || "Untitled run"}
                active={active === run.id}
                onClick={() => onSelectRun?.(run.id)}
                trailing={<span className="shrink-0 text-[10px] text-[var(--muted-foreground-2)]">{run.status}</span>}
              />
            ))}
          </PanelGroup>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-[var(--border-1)] pt-2">
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
