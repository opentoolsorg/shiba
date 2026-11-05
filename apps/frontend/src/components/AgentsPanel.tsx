import { useState, type JSX } from "react";
import { CheckSquare, ChevronDown, MessageSquare, Network, Plus, Search, Sliders, X } from "lucide-react";
import { ContextPanel, PanelIconButton, PanelNavItem, type Scope } from "./ui/ContextPanel";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";
import { agentThreads } from "../agent-threads";
import { employeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentExperience";

export interface AgentsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  agents?: CustomAgentWire[];
  threads?: WebThread[];
  onNewThread?: (agentId?: string) => void;
  onSelectThread?: (id: string) => void;
  onSelectAgent?: (id: string) => void;
  onNewAgent?: () => void;
  ownerName?: string;
  workspaceName?: string;
  className?: string;
}

/** Secondary panel for Agents: lists custom agents, expandable threads, and nav destinations. */
export function AgentsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  agents = [],
  threads = [],
  onNewThread,
  onSelectThread,
  onSelectAgent,
  onNewAgent,
  ownerName,
  workspaceName,
  className = "",
}: AgentsPanelProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (agentId: string) => {
    setExpanded((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const filteredAgents = searchQuery.trim()
    ? agents.filter((agent) =>
        agent.config.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.slug.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : agents;

  const actions = (
    <>
      <PanelIconButton
        label={searchOpen ? "Close search" : "Search agents"}
        onClick={() => {
          setSearchOpen((prev) => !prev);
          if (searchOpen) setSearchQuery("");
        }}
      >
        {searchOpen ? <X className="size-4" strokeWidth={1.75} aria-hidden="true" /> : <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />}
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
            <Search className="absolute left-2 size-3.5 text-[#71717a] dark:text-zinc-400" aria-hidden="true" />
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

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto" role="list" aria-label="Custom agents">
        {filteredAgents.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-[#71717a] dark:text-zinc-500">
            {searchQuery ? "No matching agents" : "No agents yet"}
          </p>
        ) : (
          filteredAgents.map((agent) => {
            const isExpanded = expanded[agent.id] ?? false;
            const agentThreadList = agentThreads(threads, agent.id);
            const isAgentActive = active === agent.id;
            const subtitle =
              scope === "workspace"
                ? workspaceName ? `${workspaceName} · Workspace` : "Workspace"
                : `${ownerName ?? "You"} · You`;

            return (
              <div key={agent.id} className="flex flex-col" role="listitem">
                <div
                  className={`group relative flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors ${
                    isAgentActive
                      ? "bg-[#e4e4e7] dark:bg-zinc-800"
                      : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelectAgent?.(agent.id);
                      onSelect(agent.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
                  >
                    <div className="shrink-0">
                      {agent.config.emoji ? (
                        <span className="flex size-7 items-center justify-center text-sm">{agent.config.emoji}</span>
                      ) : (
                        <AgentAvatar
                          name={agent.config.name}
                          slug={agent.slug}
                          role={employeeRole(agent.slug, agent.config.roleTemplateId)}
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-[#0a0a0a] dark:text-zinc-100">
                        {agent.config.name}
                      </div>
                      <div className="truncate text-[11px] text-[#71717a] dark:text-zinc-400">
                        {subtitle}
                      </div>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`New thread with ${agent.config.name}`}
                      title={`New thread with ${agent.config.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewThread?.(agent.id);
                      }}
                      className="flex size-6 items-center justify-center rounded text-[#71717a] hover:bg-[#d4d4d8] hover:text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                    >
                      <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${agent.config.name}`}
                      title={`${isExpanded ? "Collapse" : "Expand"} ${agent.config.name}`}
                      aria-expanded={isExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(agent.id);
                      }}
                      className="flex size-6 items-center justify-center rounded text-[#71717a] hover:bg-[#d4d4d8] hover:text-[#0a0a0a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                    >
                      <ChevronDown
                        className={`size-3.5 transition-transform duration-150 ${isExpanded ? "" : "-rotate-90"}`}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </div>

                {isExpanded ? (
                  <div
                    className="relative ml-5 mt-0.5 flex flex-col border-l border-[#e4e4e7] pl-2.5 dark:border-zinc-800"
                    role="group"
                    aria-label={`${agent.config.name} threads`}
                  >
                    {agentThreadList.length === 0 ? (
                      <span className="py-1 text-[12px] text-[#71717a] dark:text-zinc-500">No threads yet</span>
                    ) : (
                      agentThreadList.map((thread) => {
                        const isThreadActive = active === thread.id;
                        return (
                          <button
                            key={thread.id}
                            type="button"
                            aria-current={isThreadActive ? "page" : undefined}
                            onClick={() => {
                              onSelectThread?.(thread.id);
                              onSelect(thread.id);
                            }}
                            className={`group/thread relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors ${
                              isThreadActive
                                ? "bg-[#e4e4e7] font-medium text-[#0a0a0a] dark:bg-zinc-800 dark:text-zinc-100"
                                : "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"
                            }`}
                          >
                            <span className="absolute -left-2.5 top-1/2 h-px w-2 bg-[#e4e4e7] dark:bg-zinc-800" aria-hidden="true" />
                            <MessageSquare className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden="true" />
                            <span className="truncate">{thread.name || "Untitled thread"}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-auto border-t border-[#e4e4e7] pt-2 dark:border-zinc-800 flex flex-col gap-0.5">
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
