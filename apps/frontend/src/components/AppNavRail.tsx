/**
 * AppNavRail — Modern clean navigation rail matching screenshot reference.
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
  PanelLeft,
  Cpu,
  GitCompareArrows,
  Inbox,
  LayoutDashboard,
  List,
  LogOut,
  Monitor,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  SquarePen,
  Terminal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SessionItem } from "./SessionsSidebar";
import { formatTimeAgo } from "../ui-helpers";
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
  tasks: List,
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
    return "bg-[#b45309]";
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
  const [appearanceSubmenuOpen, setAppearanceSubmenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
        setAppearanceSubmenuOpen(false);
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
          ? "w-[240px] max-w-[85vw] h-full flex flex-col bg-[#0d0d0f] text-[#ececed] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none overflow-hidden"
          : "transition-all duration-200 ease-out h-full flex flex-col bg-[#0d0d0f] text-[#ececed] z-30 select-none overflow-hidden " + (collapsed ? "w-0 opacity-0 pointer-events-none p-0" : "w-[240px] shrink-0 py-3 px-3")
      }
      aria-label="Primary Left Rail"
      aria-hidden={variant === "rail" && collapsed ? true : undefined}
    >
      {/* TOP HEADER: Shiba logo mark + Search icon + Sidebar collapse icon */}
      <div className="flex items-center justify-between px-1 pb-3 mb-1.5">
        <a
          href="/"
          className="flex items-center gap-2 group focus:outline-none min-w-0"
          aria-label="Shiba Home"
        >
          <div className="size-6 rounded-full bg-[#18181b] flex items-center justify-center p-0.5 border border-[#27272a]/60 transition-transform duration-150 group-hover:scale-105">
            <img
              src="/assets/mascot/pet-logo.png"
              alt="Shiba"
              className="size-full object-contain rounded-full"
            />
          </div>
        </a>

        <div className="flex items-center gap-1 ml-auto">
          {onOpenSearch ? (
            <Tooltip content="Search" shortcut="⌘K" side="bottom">
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Search"
                className="size-6 rounded flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-[#27272a]/50 transition-colors"
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
              className="size-6 rounded flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-[#27272a]/50 transition-colors"
            >
              <X className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : onToggleCollapse ? (
            <Tooltip content="Collapse sidebar" shortcut="⌘B" side="bottom">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
                className="size-6 rounded flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-[#27272a]/50 transition-colors"
              >
                <PanelLeft className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* TOP ACTIONS: New thread (full capsule button) */}
      <div className="mb-2 px-0.5">
        <button
          type="button"
          onClick={() => {
            if (onNewTask) onNewTask();
            else onNavigate("tasks");
          }}
          aria-label="New thread"
          className="w-full flex items-center gap-2.5 rounded-lg bg-[#27272a]/70 hover:bg-[#27272a] text-[#f4f4f5] px-2.5 py-1.5 text-[13px] font-medium transition-colors border border-[#3f3f46]/30 shadow-sm"
        >
          <SquarePen className="size-3.5 text-[#a1a1aa]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">New thread</span>
        </button>
      </div>

      {/* NAV ITEMS: Threads, Pull requests, Automations, More */}
      <nav aria-label="Main" className="flex flex-col gap-0.5 mb-4 px-0.5">
        <button
          type="button"
          onClick={() => onNavigate("tasks")}
          aria-current={activeView === "tasks" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
            (activeView === "tasks"
              ? "text-[#f4f4f5] bg-[#27272a]/40"
              : "text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]/30")
          }
        >
          <List className="size-3.5 shrink-0 text-[#71717a]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Threads</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("diff")}
          aria-current={activeView === "diff" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
            (activeView === "diff"
              ? "text-[#f4f4f5] bg-[#27272a]/40"
              : "text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]/30")
          }
        >
          <GitCompareArrows className="size-3.5 shrink-0 text-[#71717a]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Pull requests</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("automations")}
          aria-current={activeView === "automations" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
            (activeView === "automations"
              ? "text-[#f4f4f5] bg-[#27272a]/40"
              : "text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]/30")
          }
        >
          <Zap className="size-3.5 shrink-0 text-[#71717a]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Automations</span>
        </button>

        {/* More popover */}
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((prev) => !prev)}
            aria-expanded={moreMenuOpen}
            aria-haspopup="true"
            className={
              "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
              (isMoreViewActive
                ? "text-[#f4f4f5] bg-[#27272a]/40"
                : "text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]/30")
            }
          >
            <MoreHorizontal className="size-3.5 shrink-0 text-[#71717a]" strokeWidth={1.8} aria-hidden="true" />
            <span className="flex-1 text-left truncate leading-none">
              {isMoreViewActive
                ? APP_NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "More"
                : "More"}
            </span>
            {pendingApprovalCount > 0 ? (
              <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--warning-fg)] text-[var(--bg)] text-[10px] font-bold flex items-center justify-center">
                {pendingApprovalCount}
              </span>
            ) : null}
          </button>

          {moreMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1 w-52 py-1 bg-[#18181b] border border-[#27272a] rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto animate-enter text-[13px]"
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
                      "w-full flex items-center gap-2.5 px-3 py-1.5 transition-colors " +
                      (active
                        ? "bg-[#27272a] text-[#f4f4f5] font-medium"
                        : "text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]/60")
                    }
                  >
                    <Icon className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} aria-hidden="true" />
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

      {/* THREADS LIST SECTION */}
      <div className="flex-1 flex flex-col min-h-0 pt-1 pb-1 overflow-hidden">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-[12px] text-[#71717a] font-normal leading-none">
            Threads
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              aria-label="Search threads"
              className="size-5 rounded flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-[#27272a]/50 transition-colors"
            >
              <Search className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (onNewTask) onNewTask();
              }}
              aria-label="Thread options"
              className="size-5 rounded flex items-center justify-center text-[#71717a] hover:text-[#d4d4d8] hover:bg-[#27272a]/50 transition-colors"
            >
              <MoreHorizontal className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>

        {searchOpen ? (
          <div className="px-0.5 pb-2">
            <div className="relative">
              <input
                type="search"
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder="Filter threads…"
                aria-label="Filter threads"
                className="w-full h-7 bg-[#18181b] border border-[#27272a] rounded-md pl-2 pr-6 text-[12px] text-[#ececed] placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46] transition-colors"
              />
              {threadQuery ? (
                <button
                  type="button"
                  onClick={() => setThreadQuery("")}
                  aria-label="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#71717a] hover:text-[#d4d4d8] text-xs"
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
            <div className="py-6 text-center">
              <p className="text-[#52525b] text-[12px]">
                {sessions.length === 0 ? "No threads yet" : "No threads match"}
              </p>
            </div>
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
                    "w-full text-left rounded-md px-2 py-1.5 flex items-center gap-2.5 transition-colors " +
                    (isSelected
                      ? "bg-[#27272a]/60 text-[#f4f4f5]"
                      : "text-[#a1a1aa] hover:bg-[#27272a]/30 hover:text-[#ececed]")
                  }
                >
                  <span
                    className={
                      "size-1.5 rounded-full shrink-0 " +
                      capyStatusDotClass(s.status, s.live)
                    }
                    aria-hidden="true"
                  />
                  <span className="block text-[13px] font-normal truncate leading-tight flex-1">
                    {s.title || "Untitled thread"}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* FOOTER USER / WORKSPACE CARD */}
      <div className="pt-2 mt-auto border-t border-[#27272a]/60 flex flex-col gap-1">
        <div ref={accountRef} className="relative">
          <button
            type="button"
            onClick={() => setAccountMenuOpen((prev) => !prev)}
            aria-expanded={accountMenuOpen}
            aria-haspopup="true"
            aria-label={accountEmail ? `${accountEmail} · workspace` : "Workspace profile"}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-[#27272a]/40 transition-colors text-left group"
          >
            <div className="size-5 rounded-sm bg-[#eab308] flex items-center justify-center shrink-0 shadow-sm" />
            <div className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12px] font-medium text-[#f4f4f5] truncate">
                {accountEmail ? accountEmail.split("@")[0] : "prince pal"}
              </span>
              <span className="block text-[10px] text-[#71717a] truncate mt-0.5">
                {accountEmail ? `${accountEmail.split("@")[0]}'s workspace` : "prince's workspace"}
              </span>
            </div>
            <ChevronUp className="size-3.5 text-[#71717a] shrink-0 group-hover:text-[#a1a1aa] transition-colors" strokeWidth={1.8} aria-hidden="true" />
          </button>

          {accountMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 bottom-full mb-1.5 w-[220px] py-1 bg-[#18181b] border border-[#27272a] rounded-lg shadow-xl z-50 animate-enter text-[13px]"
            >
              {onOpenSetup ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSetup();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a] transition-colors"
                >
                  <SlidersHorizontal className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} />
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
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a] transition-colors"
              >
                <Settings className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Settings</span>
                <kbd className="text-[10px] font-mono text-[#71717a] bg-[#27272a] px-1 py-0.5 rounded">⌘,</kbd>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("analytics");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a] transition-colors"
              >
                <Clock className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Usage</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("remote");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a] transition-colors"
              >
                <Monitor className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Open desktop app</span>
              </button>

              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setAppearanceSubmenuOpen((prev) => !prev)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a] transition-colors"
                >
                  <SunMoon className="size-4 shrink-0 text-[#71717a]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Appearance</span>
                  <ChevronRight className="size-3.5 text-[#71717a]" />
                </button>
                {appearanceSubmenuOpen && onToggleTheme ? (
                  <div className="absolute left-full bottom-0 ml-1 w-44 py-1 bg-[#18181b] border border-[#27272a] rounded-lg shadow-xl z-50">
                    <button
                      type="button"
                      onClick={() => {
                        if (theme !== "light") onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]"
                    >
                      <span>Light</span>
                      {theme === "light" ? <Check className="size-3.5 text-[#eab308]" /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (theme !== "dark") onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#27272a]"
                    >
                      <span>Dark</span>
                      {theme === "dark" ? <Check className="size-3.5 text-[#eab308]" /> : null}
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="h-px bg-[#27272a] my-1" />

              {onSignOut ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSignOut();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[#ef4444] hover:bg-[#27272a] transition-colors"
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
