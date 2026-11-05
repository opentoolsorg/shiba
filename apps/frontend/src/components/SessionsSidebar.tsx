/**
 * SessionsSidebar — Secondary Panel (~265px rounded-xl bordered card).
 *
 * Header row: title "Work" (14px/600) + search icon button.
 * Segmented control: Personal (selected: white pill) | Workspace.
 * Nav rows (34px tall, 14px, 16px icon, gap 12): List (active), Board, Timeline, Organization.
 * Collapsible groups (12px muted label + chevron):
 *   - Waiting on you → "Nothing waiting on you" (waiting-approval / needs-provider)
 *   - Running → "Nothing running" (running / live)
 *   - Recent → "No recent tasks" (everything else)
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  ChevronDown,
  GanttChart,
  Kanban,
  List,
  Network,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { AgentPrincipal } from "../types";
import { statusLabel } from "../ui-helpers";
import { Tooltip } from "./Tooltip";
import type { WorkHeaderViewMode } from "./WorkHeader";

export interface SessionItem {
  id: string; // runId, or "live" for the active chat session
  title: string; // task text (truncate display, not data)
  repoName: string; // parseRepoName(repoUrl)
  status: string; // pending|running|completed|error|aborted|cancelled|waiting-approval|live
  updatedAt: number;
  live?: boolean;
  webSession?: boolean;
}

export interface SessionsSidebarProps {
  sessions: SessionItem[];
  /** Registered MCP-token principals, shown in their own group. */
  agents: AgentPrincipal[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  connectionLabel: string; // "Connected" | "Connecting" | error text
  connectionTone: "ok" | "pending" | "error";
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onToggleCollapse?: () => void;
  isMobileDrawer?: boolean;

  /** Optional customization props */
  variant?: "work" | "sessions";
  title?: string;
  scope?: "personal" | "workspace";
  onScopeChange?: (scope: "personal" | "workspace") => void;
  activeNav?: WorkHeaderViewMode;
  onNavChange?: (nav: WorkHeaderViewMode) => void;
  onSearchClick?: () => void;
  className?: string;
}

export function statusDotClass(session: SessionItem): string {
  if (session.live || session.status === "live" || session.status === "running") {
    return "bg-[var(--primary)] animate-pulse-subtle";
  }
  if (session.status === "waiting-approval" || session.status === "pending") {
    return "bg-[var(--warning-fg)]";
  }
  if (session.status === "completed") {
    return "bg-[var(--success)]";
  }
  if (session.status === "unknown") {
    return "bg-[var(--attention)]";
  }
  if (
    session.status === "error" ||
    session.status === "aborted" ||
    session.status === "cancelled"
  ) {
    return "bg-[var(--destructive)]";
  }
  return "bg-[var(--muted-foreground-3)]";
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tooltipText = `${session.title || "Untitled session"} (${session.repoName} · ${statusLabel(session.status)})`;

  return (
    <Tooltip content={tooltipText} side="right" align="start" delayMs={400}>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={selected ? "true" : undefined}
        className={`group w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2.5 transition-colors ${
          selected
            ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
            : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
        }`}
      >
        <span
          className={`size-1.5 rounded-full shrink-0 ${statusDotClass(session)}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
          {session.title || "Untitled session"}
        </span>
      </button>
    </Tooltip>
  );
}

function AgentRow({ agent }: { agent: AgentPrincipal }) {
  const scopeLabel = agent.scopes.length === 0 ? "no scopes" : agent.scopes.join(", ");
  const tooltipText = `${agent.principal} — ${agent.live ? "live" : "offline"} · ${scopeLabel}`;

  return (
    <Tooltip content={tooltipText} side="right" align="start" delayMs={400}>
      <div className="w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2.5 text-[#71717a] dark:text-zinc-400">
        <span
          className={`size-1.5 rounded-full shrink-0 ${
            agent.live ? "bg-[var(--success)] animate-pulse-subtle" : "bg-[var(--muted-foreground-3)]"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
          {agent.principal}
        </span>
      </div>
    </Tooltip>
  );
}

const NAV_ITEMS = [
  { id: "list", label: "List", icon: List },
  { id: "board", label: "Board", icon: Kanban },
  { id: "timeline", label: "Timeline", icon: GanttChart },
  { id: "organization", label: "Organization", icon: Network },
] as const;

export function SessionsSidebar({
  sessions,
  agents,
  selectedId,
  onSelect,
  onNewTask,
  connectionLabel,
  connectionTone,
  setupDone,
  setupTotal,
  onOpenSetup,
  onToggleCollapse,
  isMobileDrawer = false,
  variant = "work",
  title: customTitle,
  scope: controlledScope,
  onScopeChange,
  activeNav: controlledNav,
  onNavChange,
  onSearchClick,
  className = "",
}: SessionsSidebarProps): JSX.Element {
  const title = customTitle ?? (variant === "sessions" ? "Sessions" : "Work");
  const [internalScope, setInternalScope] = useState<"personal" | "workspace">("personal");
  const [internalNav, setInternalNav] = useState<WorkHeaderViewMode>("list");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  const [openGroups, setOpenGroups] = useState({
    waiting: true,
    running: true,
    recent: true,
    agents: true,
  });

  const activeScope = controlledScope ?? internalScope;
  const currentNav = controlledNav ?? internalNav;

  const handleScopeChange = (nextScope: "personal" | "workspace") => {
    setInternalScope(nextScope);
    onScopeChange?.(nextScope);
  };

  const handleNavChange = (nextNav: WorkHeaderViewMode) => {
    setInternalNav(nextNav);
    onNavChange?.(nextNav);
  };

  const handleSearchToggle = () => {
    if (onSearchClick) {
      onSearchClick();
      return;
    }
    setIsSearchOpen((prev) => !prev);
  };

  const toggleGroup = (group: keyof typeof openGroups) => {
    setOpenGroups((prev) => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  // Map groups onto Shiba session states; the synthetic "default" session is never listed.
  const groupable = filtered.filter((s) => s.id !== "default");
  const isWaiting = (s: SessionItem) => s.status === "waiting-approval" || s.status === "needs-provider";
  const isRunning = (s: SessionItem) => !isWaiting(s) && (s.live || s.status === "live" || s.status === "running");
  const groups = [
    { key: "waiting", label: "Waiting on you", empty: "Nothing waiting on you", items: groupable.filter(isWaiting) },
    { key: "running", label: "Running", empty: "Nothing running", items: groupable.filter(isRunning) },
    { key: "recent", label: "Recent", empty: query ? "No sessions match your search" : "No recent tasks", items: groupable.filter((s) => !isWaiting(s) && !isRunning(s)) },
  ] as const;

  const agentsSection = agents.length > 0 ? (
    <section aria-label="Agents" className="flex flex-col">
      <button
        type="button"
        onClick={() => toggleGroup("agents")}
        aria-expanded={openGroups.agents}
        className="flex items-center gap-1.5 text-[12px] font-medium text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 py-0.5 select-none transition-colors w-fit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 rounded"
      >
        <span>Agents</span>
        <ChevronDown
          className={`size-3 text-[#71717a] transition-transform duration-150 ${openGroups.agents ? "" : "-rotate-90"}`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {openGroups.agents ? (
        <ul className="flex flex-col gap-0.5 pt-1">
          {agents.map((agent) => (
            <li key={agent.principal}>
              <AgentRow agent={agent} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  ) : null;

  return (
    <aside
      className={`w-[265px] min-w-[265px] max-w-[265px] shrink-0 h-full flex flex-col bg-white dark:bg-[#121214] border border-[#e4e4e7] dark:border-zinc-800 rounded-xl shadow-sm overflow-hidden select-none ${className}`.trim()}
      aria-label={title}
    >
      {/* Header row: title + search/new thread icon buttons */}
      <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between shrink-0">
        <h2 className="text-[14px] font-semibold text-[#0a0a0a] dark:text-zinc-100 tracking-tight">
          {title}
        </h2>
        <div className="flex items-center gap-1">
          <Tooltip content="Search sessions" side="bottom">
            <button
              type="button"
              onClick={handleSearchToggle}
              aria-label="Search sessions"
              aria-expanded={isSearchOpen}
              className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
            >
              <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>

          {isMobileDrawer && onToggleCollapse ? (
            <Tooltip content="Close drawer" side="bottom">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Close drawer"
                className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
              >
                <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* New thread button in sessions variant */}
      {variant === "sessions" ? (
        <div className="px-3 pb-2 shrink-0">
          <button
            type="button"
            onClick={onNewTask}
            aria-label="New thread"
            className="w-full h-8 px-3 rounded-lg bg-[#e4e4e7] hover:bg-[#d4d4d8] dark:bg-zinc-800 dark:hover:bg-zinc-700 text-[#0a0a0a] dark:text-zinc-100 text-[13px] font-medium flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
          >
            <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
            <span>New thread</span>
          </button>
        </div>
      ) : null}

      {/* Inline search bar (revealed when search is active or query is typed, or in sessions variant) */}
      {isSearchOpen || query || variant === "sessions" ? (
        <div className="px-3 pb-2 pt-0.5 shrink-0">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-[#71717a] pointer-events-none"
              strokeWidth={1.75}
            />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions…"
              aria-label="Search sessions"
              className="w-full h-7 bg-[#f4f4f5] dark:bg-zinc-800/60 rounded-md pl-7 pr-6 text-[12px] text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#71717a] hover:text-[#0a0a0a] text-xs"
              >
                ✕
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Segmented control: Personal | Workspace (work variant only) */}
      {variant !== "sessions" ? (
        <div className="px-3 pb-3 shrink-0">
          <div
            className="p-0.5 bg-[#f4f4f5] dark:bg-zinc-800/80 rounded-md flex items-center gap-0.5"
            role="group"
            aria-label="Work scope"
          >
            <button
              type="button"
              aria-pressed={activeScope === "personal"}
              onClick={() => handleScopeChange("personal")}
              className={`flex-1 min-h-11 rounded text-[12px] font-medium transition-all flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                activeScope === "personal"
                  ? "bg-white dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                  : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-200"
              }`}
            >
              Personal
            </button>
            <button
              type="button"
              aria-pressed={activeScope === "workspace"}
              onClick={() => handleScopeChange("workspace")}
              className={`flex-1 min-h-11 rounded text-[12px] font-medium transition-all flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                activeScope === "workspace"
                  ? "bg-white dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                  : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-200"
              }`}
            >
              Workspace
            </button>
          </div>
        </div>
      ) : null}

      {/* Nav list rows: List, Board, Timeline, Organization (work variant only) */}
      {variant !== "sessions" ? (
        <nav className="px-3 flex flex-col gap-0.5 shrink-0" aria-label="Views">
          {NAV_ITEMS.map((item) => {
            const isActive = currentNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavChange(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`w-full h-[34px] px-2.5 rounded-lg flex items-center gap-3 text-[14px] transition-colors ${
                  isActive
                    ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
                    : "text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/50 font-normal"
                }`}
              >
                <item.icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {/* Body: Full sessions list for sessions variant, or grouped collapsible sections for work variant */}
      {variant === "sessions" ? (
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <p className="text-[12px] text-[#71717a] dark:text-zinc-500 px-3 py-8 text-center text-pretty">
              {sessions.length === 0
                ? "No sessions yet — start a thread."
                : "No sessions match your search."}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5" aria-label="Sessions list">
              {filtered.map((session) => (
                <li key={session.id}>
                  <SessionRow
                    session={session}
                    selected={session.id === selectedId}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
          )}
          {agentsSection ? <div className="px-1 pt-3">{agentsSection}</div> : null}
        </div>
      ) : (
        <div className="mt-6 flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="flex flex-col">
            <button
              type="button"
              onClick={() => toggleGroup(group.key)}
              aria-expanded={openGroups[group.key]}
              className="flex items-center gap-1.5 text-[12px] font-medium text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100 py-0.5 select-none transition-colors w-fit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 rounded"
            >
              <span>{group.label}</span>
              <ChevronDown
                className={`size-3 text-[#71717a] transition-transform duration-150 ${openGroups[group.key] ? "" : "-rotate-90"}`}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
            {openGroups[group.key] ? (
              group.items.length === 0 ? (
                <p className="text-[12px] text-[#71717a] dark:text-zinc-500 py-1 select-none">{group.empty}</p>
              ) : (
                <ul className="flex flex-col gap-0.5 pt-1">
                  {group.items.map((session) => (
                    <li key={session.id}>
                      <SessionRow session={session} selected={session.id === selectedId} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>
        ))}

        {agentsSection}
      </div>
      )}

      {/* Optional discrete status footer if setup is incomplete or connection has error */}
      {(setupDone !== null && setupDone < setupTotal) || connectionTone === "error" ? (
        <div className="border-t border-[#e4e4e7] dark:border-zinc-800 px-3 py-2 flex items-center justify-between text-[11px] text-[#71717a] shrink-0 bg-[#fafafa] dark:bg-[#18181b]">
          {setupDone !== null && setupDone < setupTotal ? (
            <button
              type="button"
              onClick={onOpenSetup}
              className="text-[var(--warning-fg)] hover:underline font-medium"
            >
              Setup {setupDone}/{setupTotal}
            </button>
          ) : (
            <span />
          )}
          {connectionTone === "error" ? (
            <span className="flex items-center gap-1.5 text-[var(--destructive-fg)]">
              <span className="size-1.5 rounded-full bg-[var(--destructive)]" />
              {connectionLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
