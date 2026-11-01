/**
 * AppNavRail — workspace navigation, new threads, approval and thread groups,
 * compact setup status, and workspace profile. Shared by the rail and mobile sheet.
 */
import { useState, useMemo, useRef, useEffect, type JSX } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
  BookMarked,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  SlidersHorizontal,
  PanelLeft,
  Cpu,
  GitCompareArrows,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  List,
  LogOut,
  Monitor,
  MessagesSquare,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  SquarePen,
  Keyboard,
  Terminal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SessionItem } from "./SessionsSidebar";
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { SkeletonLines } from "./surface";
import { Tooltip } from "./Tooltip";
import { AgentSidebar } from "./AgentExperience";
import { ShibaMark } from "./ShibaMark";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";

export type AppNavView =
  | "work"
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
  | "spaces"
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
  { id: "work", label: "Work", description: "Tasks, Board & Timeline" },
  { id: "tasks", label: "Threads", description: "Tasks & Live Sessions" },
  { id: "diff", label: "Pull requests", description: "Code Changes & Git Diffs" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "dashboard", label: "Dashboard", description: "Overview & At-a-Glance Stats" },
  { id: "activity", label: "Activity", description: "Workspace activity & event log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "swarm", label: "Swarm", description: "Run Lanes, Modes & Share Links" },
  { id: "collaboration", label: "Collaboration", description: "Private rooms for people and agents" },
  { id: "providers", label: "Providers", description: "Connect AI Coding Agents" },
  { id: "skills", label: "Skills", description: "Your Saved Skills" },
  { id: "spaces", label: "Spaces", description: "Hosted coworker mini-apps" },
  { id: "custom-agents", label: "Agents", description: "Reusable agents, instructions & defaults" },
  { id: "employee-tools", label: "Tool policy", description: "Employee tool grants & approvals" },
  { id: "agents", label: "MCP", description: "Client configuration, gateway & agent tokens" },
  { id: "inbox", label: "Mailbox", description: "Cloudflare Email Routing & Send" },
  { id: "memory", label: "Memory", description: "Vectorize Long-Term Semantic Memory" },
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
  customAgentRecords?: CustomAgentWire[];
  agentThreads?: WebThread[];
  onNewAgentThread?: (agent?: CustomAgentWire) => void;
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
  work: LayoutGrid,
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
  spaces: LayoutGrid,
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
  activeSandboxCount = 0,
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
  customAgentRecords = [],
  agentThreads = [],
  onNewAgentThread,
}: AppNavRailProps): JSX.Element {
  const [needsApprovalOpen, setNeedsApprovalOpen] = useState(true);
  const [everythingOpen, setEverythingOpen] = useState(true);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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

  const approvalSessions = useMemo(() => {
    return sessions.filter((s) => s.status === "waiting-approval");
  }, [sessions]);

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
    "inbox",
    "memory",
    "providers",
    "spaces",
    "employee-tools",
    "remote",
    "settings",
  ];

  const isMoreViewActive = moreViews.includes(activeView);

  return (
    <aside
      className={
        variant === "sheet"
          ? "w-[248px] max-w-[85vw] h-full flex flex-col bg-[var(--chrome)] text-[var(--fg)] border-r border-[var(--border-1)] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none overflow-hidden"
          : "hidden lg:flex transition-all duration-200 ease-out h-full flex-col bg-[var(--chrome)] text-[var(--fg)] z-30 select-none overflow-hidden " +
            (collapsed
              ? "w-0 opacity-0 pointer-events-none border-r-0 p-0"
              : "w-[248px] shrink-0 border-r border-[var(--border-1)] py-3 px-3")
      }
      aria-label="Primary Left Rail"
      aria-hidden={variant === "rail" && collapsed ? true : undefined}
    >
      {/* TOP HEADER: Shiba wordmark (Instrument Serif) + Search icon + Sidebar collapse icon */}
      <div className="flex shrink-0 items-center justify-between px-1 pb-3 mb-1">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate("work");
          }}
          className="flex items-center gap-2 group focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 rounded-md min-w-0"
          aria-label="Shiba Home"
        >
          <ShibaMark className="size-7" />
          <span className="font-display text-[24px] text-[var(--fg)] tracking-tight leading-none select-none">
            Shiba
          </span>
        </a>

        <div className="flex items-center gap-1 ml-auto">
          {onOpenSearch ? (
            <Tooltip content="Search" shortcut="⌘K" side="bottom">
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Search"
                className="size-8 min-h-[44px] min-w-[44px]  rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
              >
                <Search className="size-4" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}

          {variant === "sheet" && onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sidebar"
              className="size-8 min-h-[44px] min-w-[44px]  rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
            >
              <X className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : onToggleCollapse ? (
            <Tooltip content="Collapse sidebar" shortcut="⌘B" side="bottom">
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
                className="size-8 min-h-[44px] min-w-[44px]  rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
              >
                <PanelLeft className="size-4" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <div role="region" aria-label="Sidebar navigation" className="min-h-0 flex-1 overflow-y-auto">
      <p className="px-3 pb-2 text-xs text-[var(--muted-foreground-2)]">Workspace</p>
      <button type="button" onClick={() => { if (onNewTask) onNewTask(); else onNavigate("tasks"); if (variant === "sheet") onClose?.(); }} className="mb-3 flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--secondary)] px-3 text-sm text-[var(--fg)] hover:bg-[var(--secondary-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"><SquarePen aria-hidden="true" className="size-4" />New thread</button>

      {/* NAV ITEMS: Work, Threads, Pull requests, Automations, More */}
      <nav aria-label="Main" className="flex flex-col gap-0.5 mb-3 px-0.5">
        <button
          type="button"
          onClick={() => onNavigate("work")}
          aria-current={activeView === "work" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
            (activeView === "work"
              ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <LayoutGrid className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Work</span>
        </button>

        <button type="button" onClick={() => onNavigate("custom-agents")} aria-current={activeView === "custom-agents" ? "page" : undefined} className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${activeView === "custom-agents" ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)]"}`}><Bot aria-hidden="true" className="size-4 text-[var(--icon-muted)]" />Agents</button>

        <button
          type="button"
          onClick={() => onNavigate("tasks")}
          aria-current={activeView === "tasks" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
            (activeView === "tasks"
              ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <List className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Threads</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("diff")}
          aria-current={activeView === "diff" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
            (activeView === "diff"
              ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <GitCompareArrows className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Pull requests</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("automations")}
          aria-current={activeView === "automations" ? "page" : undefined}
          className={
            "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
            (activeView === "automations"
              ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
              : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
          }
        >
          <Zap className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <span className="flex-1 text-left truncate leading-none">Automations</span>
        </button>

        <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--muted-foreground-3)]">Resources</p>
        {(["integrations", "skills", "agents"] as const).map((id) => {
          const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
          if (!item) return null;
          const Icon = ICONS[id];
          return <button key={id} type="button" onClick={() => { onNavigate(id); if (variant === "sheet") onClose?.(); }} aria-current={activeView === id ? "page" : undefined} title={item.description} className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${activeView === id ? "bg-[var(--secondary)] text-[var(--fg)]" : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)] hover:text-[var(--fg)]"}`}><Icon aria-hidden="true" className="size-4 shrink-0 text-[var(--icon-muted)]" /><span>{item.label}</span></button>;
        })}

        {/* More popover */}
        <div ref={moreRef} className="relative">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((prev) => !prev)}
            aria-expanded={moreMenuOpen}
            aria-haspopup="true"
            className={
              "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
              (isMoreViewActive
                ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
                : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
            }
          >
            <MoreHorizontal className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            <span className="flex-1 text-left truncate leading-none">
              {isMoreViewActive
                ? APP_NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "More"
                : "More"}
            </span>
            {pendingApprovalCount > 0 ? (
              <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] text-[10px] font-bold flex items-center justify-center rounded">
                {pendingApprovalCount}
              </span>
            ) : null}
            <ChevronDown className="size-3.5 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
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
                      "w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] " +
                      (active
                        ? "bg-[var(--secondary)] text-[var(--fg)] font-medium"
                        : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]")
                    }
                  >
                    <Icon className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {id === "approvals" && pendingApprovalCount > 0 ? (
                      <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] text-[10px] font-bold flex items-center justify-center rounded">
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

      {onNewAgentThread ? <AgentSidebar agents={customAgentRecords} threads={agentThreads} selectedId={selectedSessionId} onOpenThread={(id) => onSelectSession?.(id)} onNewThread={onNewAgentThread} onManage={() => onNavigate("custom-agents")} /> : null}

      {/* COLLAPSIBLE GROUP: Needs approval */}
      <div className="flex flex-col gap-1 mb-2">
        <button
          type="button"
          onClick={() => setNeedsApprovalOpen((prev) => !prev)}
          aria-expanded={needsApprovalOpen}
          className="w-full flex items-center justify-between px-2 py-1.5 min-h-11 text-[12px] font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
        >
          <div className="flex items-center gap-1.5">
            {needsApprovalOpen ? (
              <ChevronDown className="size-3.5 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            )}
            <span>Needs approval</span>
          </div>
          {pendingApprovalCount > 0 ? (
            <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] text-[10px] font-bold flex items-center justify-center rounded font-mono">
              {pendingApprovalCount}
            </span>
          ) : null}
        </button>

        {needsApprovalOpen ? (
          approvalSessions.length === 0 ? (
            <div className="text-[13px] text-[var(--muted-foreground-2)] px-3 py-1">
              Nothing waiting
            </div>
          ) : (
            <div className="flex flex-col space-y-0.5 px-0.5">
              {approvalSessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectSession?.(s.id)}
                  className="w-full text-left rounded-md px-2 py-1.5 min-h-11 flex items-center gap-2 hover:bg-[var(--section)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
                >
                  <span className="size-2 rounded-full shrink-0 bg-[var(--warning)]" aria-hidden="true" />
                  <span className="text-[13px] truncate flex-1 leading-tight">{s.title || "Pending approval"}</span>
                </button>
              ))}
            </div>
          )
        ) : null}
      </div>

      {/* COLLAPSIBLE GROUP: Everything (list of tasks/threads) */}
      <div className="flex flex-col pt-1 pb-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <button
            type="button"
            onClick={() => setEverythingOpen((prev) => !prev)}
            aria-expanded={everythingOpen}
            className="flex min-h-11 items-center gap-1.5 text-[12px] font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
          >
            {everythingOpen ? (
              <ChevronDown className="size-3.5 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
            )}
            <span>Everything</span>
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setSearchOpen((prev) => !prev); setEverythingOpen(true); }}
              aria-label="Search threads"
              aria-expanded={searchOpen && everythingOpen}
              aria-controls={`thread-search-${variant}`}
              className="size-6 min-h-11 min-w-11  rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
            >
              <Search className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>

        {everythingOpen ? (
          <>
            {searchOpen ? (
              <div className="px-0.5 pb-2">
                <div className="relative">
                  <input
                    ref={filterRef}
                    id={`thread-search-${variant}`}
                    type="search"
                    value={threadQuery}
                    onChange={(e) => setThreadQuery(e.target.value)}
                    placeholder="Filter threads"
                    aria-label="Filter threads"
                    className="w-full h-8 bg-[var(--input)] border border-[var(--border-1)] rounded-md pl-2 pr-6 text-[12px] text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] transition-colors"
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
              className="px-0.5 space-y-0.5"
              role="listbox"
              aria-label="Threads"
              aria-busy={threadsLoading || undefined}
              onKeyDown={(event) => {
                if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Home" ||
                  event.key === "End"
                ) {
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
                        "w-full text-left rounded-md px-2 py-1.5 min-h-11 flex items-start gap-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
                        (isSelected
                          ? "bg-[var(--secondary)] text-[var(--fg)]"
                          : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)] hover:text-[var(--fg)]")
                      }
                    >
                      <span
                        className={
                          "size-2 rounded-full shrink-0 mt-1.5 " +
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
          </>
        ) : null}
      </div>

      </div>

      <div className="shrink-0 px-2 text-xs text-[var(--muted-foreground-2)]">
        {setupDone !== null && onOpenSetup ? <button type="button" onClick={onOpenSetup} className="min-h-11 rounded px-1 hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]">Setup {setupDone}/{setupTotal}</button> : null}
        <p className="py-2">{activeSandboxCount} active sandboxes</p>
      </div>
      {/* FOOTER USER / WORKSPACE CARD */}
      <div className="pt-2 mt-auto shrink-0 border-t border-[var(--border-1)] flex flex-col gap-1">
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
            className="w-full flex items-center gap-2.5 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[var(--secondary)] transition-colors text-left group focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
          >
            <ShibaMark className="size-6" />
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
                  className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
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
                className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
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
                className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
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
                className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
              >
                <Monitor className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                <span className="flex-1 text-left">Remote access</span>
              </button>

              {onOpenShortcuts ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    onOpenShortcuts();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                >
                  <Keyboard className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} />
                  <span className="flex-1 text-left">Keyboard shortcuts</span>
                  <kbd className="text-[10px] font-mono text-[var(--muted-foreground-3)] bg-[var(--section)] px-1 py-0.5 rounded-[var(--radius-kbd)]">?</kbd>
                </button>
              ) : null}

              {onToggleTheme ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    onToggleTheme();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                >
                  <span className="flex-1 text-left">Theme: {theme === "dark" ? "Dark" : "Light"}</span>
                  <kbd className="text-[10px] font-mono text-[var(--muted-foreground-3)] bg-[var(--section)] px-1 py-0.5 rounded-[var(--radius-kbd)]">D</kbd>
                </button>
              ) : null}

              {onSignOut ? (
                <div className="pt-1 mt-1 border-t border-[var(--border-1)]">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onSignOut();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 min-h-[44px] text-[var(--destructive)] hover:bg-[var(--destructive-soft)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                  >
                    <LogOut className="size-4 shrink-0" strokeWidth={1.8} />
                    <span className="flex-1 text-left">Sign out</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
