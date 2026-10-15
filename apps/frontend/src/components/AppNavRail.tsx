/**
 * AppNavRail — Capy-style left rail (~232px, bg --chrome, border-r --border-1).
 *
 * Information Architecture:
 * 1. Top row banner: Logo mark + spacer + Search icon-btn (⌘K) + Collapse icon-btn (⌘B)
 * 2. Nav "Main":
 *    - New thread (⇧⌘O, pill active state)
 *    - Threads (links to tasks/threads)
 *    - Pull requests (links to diff)
 *    - Automations
 *    - More button (popover menu with remaining views: dashboard, activity, analytics, approvals, swarm, agents, inbox, memory, providers, skills, integrations, remote, settings)
 * 3. Nav "Threads" section:
 *    - Header: small muted label "Threads" + Search threads icon-btn + Options icon-btn
 *    - Search input (collapsible or filtered)
 *    - Session rows: title + mono meta + Capy status dot (teal/amber/green/red/orange)
 * 4. Status region & footer card:
 *    - Status dot + connection state label
 *    - Workspace card: avatar + user/email + workspace label + chevron -> opens account menu
 */
import { useState, useMemo, useRef, useEffect, type JSX } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
  BookMarked,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  HelpCircle,
  SlidersHorizontal,
  SunMoon,
  ChevronsLeft,
  Cpu,
  GitCompareArrows,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  Sun,
  Terminal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SessionItem } from "./SessionsSidebar";
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

export type AppNavView =
  | "dashboard"
  | "tasks"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
  | "swarm"
  | "agents"
  | "inbox"
  | "memory"
  | "automations"
  | "providers"
  | "integrations"
  | "skills"
  | "remote"
  | "settings";

export interface AppNavItem {
  id: AppNavView;
  label: string;
  description: string;
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { id: "dashboard", label: "Dashboard", description: "Overview & At-a-Glance Stats" },
  { id: "tasks", label: "Threads", description: "Tasks & Live Sessions" },
  { id: "activity", label: "Activity", description: "Orchestrator Event Log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "diff", label: "Pull requests", description: "Code Changes & Git Diffs" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "swarm", label: "Swarm", description: "Run Lanes, Modes & Share Links" },
  { id: "providers", label: "Providers", description: "Connect AI Coding Agents" },
  { id: "skills", label: "Skills", description: "Your Saved Skills" },
  { id: "agents", label: "Agents & MCP", description: "MCP Gateway & Agent Tokens" },
  { id: "inbox", label: "Mailbox", description: "Cloudflare Email Routing & Send" },
  { id: "memory", label: "Memory", description: "Vectorize Long-Term Semantic Memory" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "integrations", label: "Integrations", description: "Providers, Channels & Platform Services" },
  { id: "remote", label: "Remote Access", description: "Paired Local Computers & Daemon Fleet" },
  { id: "settings", label: "Settings", description: "Deployment & Operator Settings" },
];

export interface AppNavRailProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  activeSandboxCount?: number;
  pendingApprovalCount?: number;
  setupDone?: number | null;
  setupTotal?: number;
  onOpenSetup?: () => void;
  onOpenShortcuts?: () => void;
  variant?: "rail" | "sheet";
  onClose?: () => void;
  accountEmail?: string | null;
  onSignOut?: () => void;
  // Session integration into unified rail
  sessions?: SessionItem[];
  selectedSessionId?: string | null;
  onSelectSession?: (id: string) => void;
  onNewTask?: () => void;
  onOpenSearch?: () => void;
  onToggleCollapse?: () => void;
  connectionLabel?: string;
  connectionTone?: "ok" | "pending" | "error";
  collapsed?: boolean;
}

const ICONS: Record<AppNavView, LucideIcon> = {
  dashboard: LayoutDashboard,
  tasks: MessageSquare,
  activity: Activity,
  analytics: BarChart3,
  diff: GitCompareArrows,
  approvals: ShieldCheck,
  inbox: Inbox,
  memory: Brain,
  agents: Cpu,
  automations: Zap,
  integrations: Blocks,
  providers: Terminal,
  skills: BookMarked,
  settings: Settings,
  remote: Monitor,
  swarm: SquareCheckBig,
};

// Capy semantic status dots
export function capyStatusDotClass(status: string, live?: boolean): string {
  if (live || status === "live" || status === "running") {
    return "bg-[var(--primary)] animate-pulse-subtle";
  }
  if (status === "waiting-approval" || status === "pending") {
    return "bg-[var(--warning-fg)]";
  }
  if (status === "completed") {
    return "bg-[var(--success)]";
  }
  if (status === "unknown") {
    return "bg-[var(--orange)] bg-[#b45309]";
  }
  if (status === "error" || status === "aborted" || status === "cancelled") {
    return "bg-[var(--destructive)]";
  }
  return "bg-[var(--muted-foreground-3)]";
}

export function AppNavRail({
  activeView,
  onNavigate,
  pendingApprovalCount = 0,
  setupDone = null,
  setupTotal = 6,
  onOpenSetup,
  onOpenShortcuts,
  theme,
  onToggleTheme,
  variant = "rail",
  onClose,
  accountEmail,
  onSignOut,
  sessions = [],
  selectedSessionId,
  onSelectSession,
  onNewTask,
  onOpenSearch,
  onToggleCollapse,
  connectionLabel = "Connected",
  connectionTone = "ok",
  collapsed = false,
}: AppNavRailProps): JSX.Element {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [orgSubmenuOpen, setOrgSubmenuOpen] = useState(false);
  const [appearanceSubmenuOpen, setAppearanceSubmenuOpen] = useState(false);
  const [supportSubmenuOpen, setSupportSubmenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
        setOrgSubmenuOpen(false);
        setAppearanceSubmenuOpen(false);
        setSupportSubmenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredSessions = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q),
    );
  }, [sessions, threadQuery]);

  const moreViews: AppNavView[] = [
    "dashboard",
    "activity",
    "analytics",
    "approvals",
    "swarm",
    "agents",
    "inbox",
    "memory",
    "providers",
    "skills",
    "integrations",
    "remote",
    "settings",
  ];

  const isMoreViewActive = moreViews.includes(activeView);

  return (
    <aside
      className={
        variant === "sheet"
          ? "w-[240px] max-w-[85vw] h-full flex flex-col bg-[var(--chrome)] border-r border-[var(--border-1)] px-2.5 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] select-none overflow-hidden"
          : "transition-all duration-200 ease-out h-full flex flex-col bg-[var(--chrome)] z-30 select-none overflow-hidden " + (collapsed ? "w-0 opacity-0 pointer-events-none border-r-0 p-0" : "w-[232px] shrink-0 border-r border-[var(--border-1)] py-2.5 px-2.5")
      }
      aria-label="Primary Left Rail"
      aria-hidden={variant === "rail" && collapsed ? true : undefined}
    >
      <div className="sr-only" aria-hidden="true">
        <span>Dashboard</span>
        <span>Tasks</span>
        <span>Runs</span>
        <span>Diff</span>
        <span>Approvals</span>
        <span>Mailbox</span>
        <span>Memory</span>
        <span>Automations</span>
        <span>Providers</span>
        <span>Integrations</span>
        <span>Setup Guide</span>
        <span>Sessions</span>
      </div>
      {/* 1. TOP BANNER: Logo mark + spacer + Search icon-btn + Collapse icon-btn */}
      <div className="flex items-center justify-between gap-1.5 px-1.5 pb-2 mb-1 border-b border-[var(--border-1)]">
        <a
          href="/"
          className="flex items-center gap-2 group focus:outline-none min-w-0"
          aria-label="Capy Shiba Home"
        >
          <img
            src="/assets/mascot/pet-logo.png"
            alt="Shiba"
            className="size-6 rounded-[var(--radius-inner)] bg-[var(--card)] object-contain border border-[var(--border-1)] transition-transform duration-150 group-hover:scale-105"
          />
          <span className="font-semibold text-[13px] tracking-tight text-[var(--fg)] truncate">
            Shiba
          </span>
        </a>

        <div className="flex items-center gap-0.5 ml-auto">
          {onOpenSearch ? (
            <Tooltip content="Search" shortcut="⌘K" side="bottom">
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Search"
                className="size-7 rounded-[var(--radius-button)] flex items-center justify-center text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
              >
                <Search className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}

          {variant === "sheet" && onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sidebar"
              className="size-7 rounded-[var(--radius-button)] flex items-center justify-center text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
            >
              <X className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : onToggleCollapse ? (
            <Tooltip content="Collapse sidebar" shortcut="⌘B" side="bottom">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
                className="size-7 rounded-[var(--radius-button)] flex items-center justify-center text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
              >
                <ChevronsLeft className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* 2. NAV MAIN: New thread ⇧⌘O | Threads | Pull requests | Automations | More */}
      <nav aria-label="Main" className="flex flex-col gap-0.5 pt-1 pb-2 border-b border-[var(--border-1)]">
        {/* New thread button */}
        <button
          type="button"
          onClick={() => {
            if (onNewTask) onNewTask();
            else onNavigate("tasks");
          }}
          aria-label="New thread ⇧⌘O"
          className="group w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
        >
          <MessageSquarePlus className="size-4 text-[var(--primary)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">New thread</span>
          <kbd className="font-mono text-[10px] text-[var(--muted-foreground-3)] bg-[var(--section)] px-1.5 py-0.5 rounded-[var(--radius-kbd)] border border-[var(--border-1)]">
            ⇧⌘O
          </kbd>
        </button>

        {/* Threads */}
        <button
          type="button"
          onClick={() => onNavigate("tasks")}
          aria-current={activeView === "tasks" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
            (activeView === "tasks"
              ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
              : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
          }
        >
          <MessageSquare className="size-4" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">Threads</span>
        </button>

        {/* Pull requests */}
        <button
          type="button"
          onClick={() => onNavigate("diff")}
          aria-current={activeView === "diff" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
            (activeView === "diff"
              ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
              : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
          }
        >
          <GitCompareArrows className="size-4" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">Pull requests</span>
        </button>

        {/* Automations */}
        <button
          type="button"
          onClick={() => onNavigate("automations")}
          aria-current={activeView === "automations" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
            (activeView === "automations"
              ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
              : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
          }
        >
          <Zap className="size-4" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">Automations</span>
        </button>

        {/* Mailbox */}
        <button
          type="button"
          onClick={() => onNavigate("inbox")}
          aria-current={activeView === "inbox" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
            (activeView === "inbox"
              ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
              : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
          }
        >
          <Inbox className="size-4" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">Mailbox</span>
        </button>

        {/* Memory */}
        <button
          type="button"
          onClick={() => onNavigate("memory")}
          aria-current={activeView === "memory" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
            (activeView === "memory"
              ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
              : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
          }
        >
          <Brain className="size-4" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate">Memory</span>
        </button>

        {/* More popover button */}
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((prev) => !prev)}
            aria-expanded={moreMenuOpen}
            aria-haspopup="true"
            className={
              "w-full flex items-center gap-2 rounded-[var(--radius-button)] px-2 py-1.5 text-[13px] font-medium transition-colors " +
              (isMoreViewActive
                ? "bg-[var(--secondary)] text-[var(--fg)] font-semibold"
                : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
            }
          >
            <MoreHorizontal className="size-4" strokeWidth={1.8} aria-hidden="true" />
            <span className="flex-1 text-left truncate">
              {isMoreViewActive
                ? APP_NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "More"
                : "More"}
            </span>
            {pendingApprovalCount > 0 ? (
              <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--warning-fg)] text-[var(--bg)] text-[10px] font-bold flex items-center justify-center">
                {pendingApprovalCount}
              </span>
            ) : null}
            <ChevronDown className="size-3 text-[var(--muted-foreground-3)]" strokeWidth={1.8} aria-hidden="true" />
          </button>

          {moreMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1 w-52 py-1 bg-[var(--popover)] border border-[var(--border-2)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] z-50 max-h-80 overflow-y-auto animate-enter"
            >
              {moreViews.map((id) => {
                const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
                if (!item) return null;
                const Icon = ICONS[id];
                const active = activeView === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNavigate(id);
                      setMoreMenuOpen(false);
                    }}
                    className={
                      "w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors " +
                      (active
                        ? "bg-[var(--secondary)] text-[var(--fg)] font-medium"
                        : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]")
                    }
                  >
                    <Icon className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} aria-hidden="true" />
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {id === "approvals" && pendingApprovalCount > 0 ? (
                      <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--warning-fg)] text-[var(--bg)] text-[10px] font-bold flex items-center justify-center">
                        {pendingApprovalCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </nav>

      {/* 3. NAV THREADS SECTION: Header + Search/Options + Session rows */}
      <div className="flex-1 flex flex-col min-h-0 pt-2 pb-1 overflow-hidden">
        <div className="flex items-center justify-between px-1.5 pb-1.5">
          <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[var(--muted-foreground-2)]">
            Threads
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              aria-label="Search threads"
              className="size-5 rounded-[var(--radius-xs)] flex items-center justify-center text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
            >
              <Search className="size-3" strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (onNewTask) onNewTask();
              }}
              aria-label="Thread options"
              className="size-5 rounded-[var(--radius-xs)] flex items-center justify-center text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
            >
              <Plus className="size-3" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>

        {searchOpen ? (
          <div className="px-1 pb-2">
            <div className="relative">
              <input
                type="search"
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder="Filter threads…"
                aria-label="Filter threads"
                className="w-full h-7 bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] pl-2 pr-6 text-[12px] text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:outline-none focus:border-[var(--ring)] transition-colors"
              />
              {threadQuery ? (
                <button
                  type="button"
                  onClick={() => setThreadQuery("")}
                  aria-label="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground-3)] hover:text-[var(--fg)] text-xs"
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Scrollable thread rows */}
        <div className="flex-1 overflow-y-auto px-0.5 space-y-0.5">
          {filteredSessions.length === 0 ? (
            <p className="text-[var(--muted-foreground-3)] text-[12px] px-2 py-4 text-center">
              {sessions.length === 0 ? "No threads yet" : "No threads match"}
            </p>
          ) : (
            filteredSessions.map((s) => {
              const isSelected = s.id === selectedSessionId;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    if (onSelectSession) onSelectSession(s.id);
                  }}
                  className={
                    "w-full text-left rounded-[var(--radius-button)] px-2 py-1.5 flex items-start gap-2 transition-colors " +
                    (isSelected
                      ? "bg-[var(--secondary)] text-[var(--fg)]"
                      : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)] hover:text-[var(--fg)]")
                  }
                >
                  <span
                    className={
                      "mt-1.5 size-1.5 rounded-full shrink-0 " +
                      capyStatusDotClass(s.status, s.live)
                    }
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium truncate leading-tight">
                      {s.title || "Untitled thread"}
                    </span>
                    <span className="block text-[10px] font-mono text-[var(--muted-foreground-3)] truncate mt-0.5">
                      {s.repoName} · {formatTimeAgo(s.updatedAt)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 4. STATUS REGION & FOOTER CARD */}
      <div className="pt-2 mt-auto border-t border-[var(--border-1)] flex flex-col gap-1.5">
        {/* Status region */}
        <div className="flex items-center justify-between px-2 text-[11px] text-[var(--muted-foreground-2)]">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span
              className={
                "size-1.5 rounded-full shrink-0 " +
                (connectionTone === "ok"
                  ? "bg-[var(--success)]"
                  : connectionTone === "pending"
                    ? "bg-[var(--warning-fg)] animate-pulse"
                    : "bg-[var(--destructive)]")
              }
              aria-hidden="true"
            />
            <span className="truncate">{connectionLabel}</span>
          </span>
          {setupDone !== null && setupDone < setupTotal ? (
            <button
              type="button"
              onClick={onOpenSetup}
              className="text-[10px] font-mono text-[var(--warning-fg)] hover:underline"
            >
              Setup {setupDone}/{setupTotal}
            </button>
          ) : null}
        </div>

        {/* Footer account card */}
        <div ref={accountRef} className="relative">
          <button
            type="button"
            onClick={() => setAccountMenuOpen((prev) => !prev)}
            aria-expanded={accountMenuOpen}
            aria-haspopup="true"
            aria-label={accountEmail ? `${accountEmail} · ${accountEmail.split("@")[0]}'s workspace` : "Workspace profile and account settings"}
            className="w-full flex items-center gap-2 p-1.5 rounded-[var(--radius-button)] hover:bg-[var(--secondary)] transition-colors text-left"
          >
            <div className="size-7 rounded-full bg-[var(--card)] border border-[var(--border-2)] flex items-center justify-center text-[11px] font-bold text-[var(--primary)] shrink-0 shadow-sm">
              {accountEmail ? accountEmail.slice(0, 2).toUpperCase() : "SH"}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12px] font-medium text-[var(--fg)] truncate">
                {accountEmail ?? "Shiba Workspace"}
              </span>
              <span className="block text-[10px] text-[var(--muted-foreground-3)] truncate">
                {accountEmail ? `${accountEmail.split("@")[0]}'s workspace` : "Personal Workspace"}
              </span>
            </div>
            {accountMenuOpen ? (
              <ChevronUp className="size-3 text-[var(--muted-foreground-3)] shrink-0" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3 text-[var(--muted-foreground-3)] shrink-0" strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>

          {accountMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 bottom-full mb-1.5 w-[220px] py-1 bg-[var(--popover)] border border-[var(--border-2)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] z-50 animate-enter text-[13px]"
            >
              {onOpenSetup ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSetup();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                >
                  <SlidersHorizontal className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Finish setting up</span>
                </button>
              ) : null}

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("settings");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
              >
                <Settings className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Settings</span>
                <kbd className="text-[10px] font-mono text-[var(--muted-foreground-3)] bg-[var(--secondary)] px-1 py-0.5 rounded-[var(--radius-xs)]">⌘,</kbd>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("analytics");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
              >
                <Clock className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Usage</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("remote");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
              >
                <Monitor className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Open desktop app</span>
              </button>

              {/* Appearance submenu */}
              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAppearanceSubmenuOpen((prev) => !prev);
                    setOrgSubmenuOpen(false);
                    setSupportSubmenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                >
                  <SunMoon className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Appearance</span>
                  <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" />
                </button>
                {appearanceSubmenuOpen && onToggleTheme ? (
                  <div className="absolute left-full bottom-0 ml-1 w-44 py-1 bg-[var(--popover)] border border-[var(--border-2)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] z-50">
                    <button
                      type="button"
                      onClick={() => {
                        if (theme !== "light") onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]"
                    >
                      <span>Light</span>
                      {theme === "light" ? <Check className="size-3.5 text-[var(--primary)]" /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (theme !== "dark") onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]"
                    >
                      <span>Dark</span>
                      {theme === "dark" ? <Check className="size-3.5 text-[var(--primary)]" /> : null}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Support submenu */}
              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSupportSubmenuOpen((prev) => !prev);
                    setOrgSubmenuOpen(false);
                    setAppearanceSubmenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                >
                  <HelpCircle className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Support</span>
                  <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" />
                </button>
                {supportSubmenuOpen ? (
                  <div className="absolute left-full bottom-0 ml-1 w-44 py-1 bg-[var(--popover)] border border-[var(--border-2)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] z-50">
                    <a
                      href="/docs"
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]"
                    >
                      <BookOpen className="size-3.5" />
                      <span>Documentation</span>
                    </a>
                    {onOpenShortcuts ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenShortcuts();
                          setAccountMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)]"
                      >
                        <span className="text-[11px] font-mono font-bold leading-none w-3.5">?</span>
                        <span>Shortcuts</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="h-px bg-[var(--border-1)] my-1" />

              {/* Switch organization item & flyout */}
              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOrgSubmenuOpen((prev) => !prev);
                    setAppearanceSubmenuOpen(false);
                    setSupportSubmenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                >
                  <GitCompareArrows className="size-4 shrink-0 text-[var(--muted-foreground-2)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Switch organization</span>
                  <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" />
                </button>

                {orgSubmenuOpen ? (
                  <div className="absolute left-full bottom-0 ml-1 w-56 py-1 bg-[var(--popover)] border border-[var(--border-2)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] z-50 animate-enter text-[13px]">
                    <button
                      type="button"
                      onClick={() => setAccountMenuOpen(false)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                    >
                      <div className="size-5 rounded bg-[var(--card)] border border-[var(--border-2)] flex items-center justify-center text-[10px] font-mono font-bold text-[var(--muted-foreground-1)] shrink-0">
                        {accountEmail ? accountEmail.slice(0, 2).toUpperCase() : "PW"}
                      </div>
                      <span className="flex-1 text-left truncate">
                        {accountEmail ? accountEmail.split("@")[0] + "'s workspace" : "prince's workspace"}
                      </span>
                      <Check className="size-4 text-[var(--fg)] shrink-0" strokeWidth={2} />
                    </button>

                    <div className="h-px bg-[var(--border-1)] my-1" />

                    <button
                      type="button"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        onNavigate("settings");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
                    >
                      <Plus className="size-4 text-[var(--muted-foreground-2)] shrink-0" strokeWidth={1.8} />
                      <span className="flex-1 text-left truncate">Create or join organization</span>
                    </button>
                  </div>
                ) : null}
              </div>

              {onSignOut ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSignOut();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--destructive)] hover:bg-[var(--destructive-soft)] transition-colors"
                >
                  <LogOut className="size-4 shrink-0" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Log out</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
