/**
 * AppNavRail — left rail: primary views, thread list, workspace menu.
 */
import { useState, useMemo, useRef, useEffect, type JSX } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
  BookMarked,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  MessagesSquare,
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
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { SkeletonLines } from "./surface";
import { Tooltip } from "./Tooltip";

export type AppNavView =
  | "dashboard"
  | "tasks"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
  | "swarm"
  | "collaboration"
  | "agents"
  | "inbox"
  | "memory"
  | "automations"
  | "providers"
  | "integrations"
  | "skills"
  | "custom-agents"
  | "employee-tools"
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
  { id: "activity", label: "Activity", description: "Workspace activity & event log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "diff", label: "Pull requests", description: "Code Changes & Git Diffs" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "swarm", label: "Swarm", description: "Run Lanes, Modes & Share Links" },
  { id: "collaboration", label: "Collaboration", description: "Private rooms for people and agents" },
  { id: "providers", label: "Providers", description: "Connect AI Coding Agents" },
  { id: "skills", label: "Skills", description: "Your Saved Skills" },
  { id: "custom-agents", label: "Bots", description: "Reusable bot profiles & defaults" },
  { id: "employee-tools", label: "Tool policy", description: "Employee tool grants & approvals" },
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
  /** True until the first sessions + runs response. Keeps the list from flashing empty. */
  threadsLoading?: boolean;
}

export function workspaceLabel(accountEmail: string | null | undefined): { name: string; detail: string } {
  const email = accountEmail?.trim();
  if (!email) return { name: "Signed in", detail: "This workspace" };
  if (email.includes("@")) {
    const name = email.split("@")[0] || email;
    return { name, detail: email };
  }
  return { name: email, detail: "This workspace" };
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
  "custom-agents": Bot,
  "employee-tools": ShieldCheck,
  settings: Settings,
  remote: Monitor,
  swarm: SquareCheckBig,
  collaboration: MessagesSquare,
};

export function navStatusDotClass(status: string, live?: boolean): string {
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
    return "bg-[var(--attention)]";
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
  threadsLoading = false,
}: AppNavRailProps): JSX.Element {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [appearanceSubmenuOpen, setAppearanceSubmenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const identity = workspaceLabel(accountEmail);

  useEffect(() => {
    if (searchOpen) filterRef.current?.focus();
  }, [searchOpen]);

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

  const moveThread = (key: string) => {
    if (!onSelectSession || filteredSessions.length === 0) return;
    const currentIndex = filteredSessions.findIndex((session) => session.id === selectedSessionId);
    const last = filteredSessions.length - 1;
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (key === "ArrowDown") nextIndex = Math.min(last, nextIndex + (currentIndex < 0 ? 0 : 1));
    else if (key === "ArrowUp") nextIndex = Math.max(0, nextIndex - (currentIndex < 0 ? 0 : 1));
    else if (key === "Home") nextIndex = 0;
    else nextIndex = last;
    const next = filteredSessions[nextIndex];
    if (!next) return;
    onSelectSession(next.id);
    requestAnimationFrame(() => {
      document.getElementById(`thread-${next.id}`)?.focus();
    });
  };

  const moreViews: AppNavView[] = [
    "dashboard",
    "activity",
    "analytics",
    "approvals",
    "swarm",
    "collaboration",
    "agents",
    "inbox",
    "memory",
    "providers",
    "skills",
    "custom-agents",
    "employee-tools",
    "integrations",
    "remote",
    "settings",
  ];

  const isMoreViewActive = moreViews.includes(activeView);

  return (
    <aside
      className={
        variant === "sheet"
          ? "w-[240px] max-w-[85vw] h-full flex flex-col bg-[var(--chrome)] text-[var(--fg)] border-r border-[var(--border-1)] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none overflow-hidden"
          : "hidden lg:flex transition-all duration-200 ease-out h-full flex-col bg-[var(--chrome)] text-[var(--fg)] z-30 select-none overflow-hidden " + (collapsed ? "w-0 opacity-0 pointer-events-none border-r-0 p-0" : "w-[240px] shrink-0 border-r border-[var(--border-1)] py-3 px-3")
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
          <div className="size-6 rounded-full bg-[var(--card)] flex items-center justify-center p-0.5 border border-[var(--border-1)] transition-transform duration-150 group-hover:scale-105">
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
                className="size-6 rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
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
              className="size-6 rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
            >
              <X className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : onToggleCollapse ? (
            <Tooltip content="Collapse sidebar" shortcut="⌘B" side="bottom">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
                className="size-6 rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
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
          className="w-full flex items-center gap-2.5 rounded-lg bg-[var(--secondary)] hover:bg-[var(--secondary-hover)] text-[var(--fg)] px-2.5 py-1.5 text-[13px] font-medium transition-colors border border-[var(--border-1)] shadow-plate"
        >
          <SquarePen className="size-3.5 text-[var(--muted-foreground-2)]" strokeWidth={1.8} aria-hidden="true" />
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
              ? "text-[var(--fg)] bg-[var(--secondary)]"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <List className="size-3.5 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Threads</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("diff")}
          aria-current={activeView === "diff" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
            (activeView === "diff"
              ? "text-[var(--fg)] bg-[var(--secondary)]"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <GitCompareArrows className="size-3.5 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Pull requests</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("automations")}
          aria-current={activeView === "automations" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal transition-colors " +
            (activeView === "automations"
              ? "text-[var(--fg)] bg-[var(--secondary)]"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <Zap className="size-3.5 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
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
                ? "text-[var(--fg)] bg-[var(--secondary)]"
                : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
            }
          >
            <MoreHorizontal className="size-3.5 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            <span className="flex-1 text-left truncate leading-none">
              {isMoreViewActive
                ? APP_NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "More"
                : "More"}
            </span>
            {pendingApprovalCount > 0 ? (
              <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] text-[10px] font-bold flex items-center justify-center">
                {pendingApprovalCount}
              </span>
            ) : null}
          </button>

          {moreMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1 w-52 py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 max-h-80 overflow-y-auto animate-enter text-[13px]"
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
                        ? "bg-[var(--secondary)] text-[var(--fg)] font-medium"
                        : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]")
                    }
                  >
                    <Icon className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {id === "approvals" && pendingApprovalCount > 0 ? (
                      <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] text-[10px] font-bold flex items-center justify-center">
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
          <span className="text-[12px] text-[var(--muted-foreground-3)] font-normal leading-none">
            Threads
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              aria-label="Search threads"
              className="size-5 rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
            >
              <Search className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>

        {searchOpen ? (
          <div className="px-0.5 pb-2">
            <div className="relative">
              <input
                ref={filterRef}
                type="search"
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder="Filter threads"
                aria-label="Filter threads"
                className="w-full h-7 bg-[var(--input)] border border-[var(--border-1)] rounded-[var(--radius-inner)] pl-2 pr-6 text-[12px] text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:outline-none focus:border-[var(--border-3)] transition-colors"
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

        <div
          className="flex-1 overflow-y-auto px-0.5 space-y-0.5"
          role="listbox"
          aria-label="Threads"
          aria-busy={threadsLoading || undefined}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              moveThread(event.key);
            }
          }}
        >
          {threadsLoading ? (
            <div className="px-2 py-2" role="status" aria-label="Loading threads">
              <SkeletonLines rows={4} />
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="py-6 px-2 text-center">
              <p className="text-[var(--muted-foreground-2)] text-[12px]">
                {sessions.length === 0
                  ? "No threads yet. Use New thread to start one."
                  : `No threads match “${threadQuery.trim()}”.`}
              </p>
            </div>
          ) : (
            filteredSessions.map((s) => {
              const isSelected = s.id === selectedSessionId;
              const title = s.title || "Untitled thread";
              const when = s.updatedAt > 0 ? formatTimeAgo(s.updatedAt) : null;
              const meta = [statusLabel(s.status), s.repoName, when].filter(Boolean).join(" · ");
              return (
                <button
                  key={s.id}
                  id={`thread-${s.id}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    if (onSelectSession) onSelectSession(s.id);
                  }}
                  className={
                    "w-full text-left rounded-md px-2 py-1.5 flex items-start gap-2.5 transition-colors " +
                    (isSelected
                      ? "bg-[var(--secondary)] text-[var(--fg)]"
                      : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)] hover:text-[var(--fg)]")
                  }
                >
                  <span
                    className={
                      "size-1.5 rounded-full shrink-0 mt-1.5 " +
                      navStatusDotClass(s.status, s.live)
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-normal truncate leading-tight">
                      {title}
                    </span>
                    <span className="block text-[10px] font-mono text-[var(--muted-foreground-3)] truncate mt-0.5">
                      {meta}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* FOOTER USER / WORKSPACE CARD */}
      <div className="pt-2 mt-auto border-t border-[var(--border-1)] flex flex-col gap-1">
        <p className="px-2 pb-1 text-[10px] font-mono text-[var(--muted-foreground-3)] flex items-center gap-1.5 min-w-0">
          <span
            className={
              "size-1.5 rounded-full shrink-0 " +
              (connectionTone === "ok"
                ? "bg-[var(--success)]"
                : connectionTone === "pending"
                  ? "bg-[var(--warning-fg)]"
                  : "bg-[var(--destructive)]")
            }
            aria-hidden="true"
          />
          <span className="truncate">{connectionLabel}</span>
        </p>
        <div ref={accountRef} className="relative">
          <button
            type="button"
            onClick={() => setAccountMenuOpen((prev) => !prev)}
            aria-expanded={accountMenuOpen}
            aria-haspopup="true"
            aria-label={accountEmail ? `${accountEmail} · workspace` : "Workspace profile"}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-[var(--secondary)] transition-colors text-left group"
          >
            <div className="size-5 bg-[var(--primary)] flex items-center justify-center shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12px] font-medium text-[var(--fg)] truncate">
                {identity.name}
              </span>
              <span className="block text-[10px] text-[var(--muted-foreground-3)] truncate mt-0.5">
                {identity.detail}
              </span>
            </div>
            <ChevronUp className="size-3.5 text-[var(--muted-foreground-3)] shrink-0 group-hover:text-[var(--muted-foreground-1)] transition-colors" strokeWidth={1.8} aria-hidden="true" />
          </button>

          {accountMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 bottom-full mb-1.5 w-[220px] py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 animate-enter text-[13px]"
            >
              {onOpenSetup ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSetup();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                >
                  <SlidersHorizontal className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
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
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
              >
                <Settings className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Settings</span>
                <kbd className="text-[10px] font-mono text-[var(--muted-foreground-3)] bg-[var(--section)] px-1 py-0.5 rounded-[var(--radius-kbd)]">⌘,</kbd>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("analytics");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
              >
                <Clock className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Usage</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onNavigate("remote");
                }}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
              >
                <Monitor className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Open desktop app</span>
              </button>

              <div className="relative">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setAppearanceSubmenuOpen((prev) => !prev)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                >
                  <SunMoon className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Appearance</span>
                  <ChevronRight className="size-3.5 text-[var(--muted-foreground-3)]" />
                </button>
                {appearanceSubmenuOpen && onToggleTheme ? (
                  <div className="absolute left-full bottom-0 ml-1 w-44 py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50">
                    <button
                      type="button"
                      onClick={() => {
                        if (theme !== "light") onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]"
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
                      className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]"
                    >
                      <span>Dark</span>
                      {theme === "dark" ? <Check className="size-3.5 text-[var(--primary)]" /> : null}
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="h-px bg-[var(--border-1)] my-1" />

              {onSignOut ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSignOut();
                    setAccountMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[var(--destructive)] hover:bg-[var(--popover-hover)] transition-colors"
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
