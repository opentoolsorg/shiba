/**
 * AppNavRail — workspace shell navigation:
 * On desktop (variant "rail", every view): labeled primary rail (Work, Agents, Chats, Insights, More; bottom controls and account menu).
 * On mobile (variant === "sheet"): full navigation drawer with the thread list.
 */
import { useState, useMemo, useRef, useEffect, useId, type JSX } from "react";
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
  Cpu,
  GitCompareArrows,
  HelpCircle,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  List,
  ListChecks,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  SquarePen,
  Sun,
  Terminal,
  Users,
  Workflow,
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
import { WorkspaceMenuList } from "./WorkspaceSwitcher";
import type { TeamWorkspaceSummary } from "@shiba/shared";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";

export type AppNavView =
  | "work"
  | "dashboard"
  | "tasks"
  | "threads"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
  | "swarm"
  | "collaboration"
  | "team"
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
  { id: "tasks", label: "Tasks", description: "Agent task queues & handoff" },
  { id: "threads", label: "Threads", description: "Conversations & Live Sessions" },
  { id: "diff", label: "Pull requests", description: "Code Changes & Git Diffs" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "dashboard", label: "Dashboard", description: "Overview & At-a-Glance Stats" },
  { id: "activity", label: "Activity", description: "Workspace activity & event log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "swarm", label: "Swarm", description: "Run Lanes, Modes & Share Links" },
  { id: "collaboration", label: "Collaboration", description: "Private rooms for people and agents" },
  { id: "team", label: "Team", description: "Workspaces, members and invitations" },
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
  sidebarPanelId?: string;
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
  workspaceSwitcher?: React.ReactNode;
  workspaces?: TeamWorkspaceSummary[];
  selectedWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  remoteLabel?: string;
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
  threads: MessagesSquare,
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
  team: Users,
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

const CURATED_WORKFLOWS = [
  {
    id: "pr-review",
    title: "PR Code Review Sweep",
    schedule: "Triggered on pull request",
    icon: GitCompareArrows,
    status: "Active",
  },
  {
    id: "ci-hygiene",
    title: "Daily CI Hygiene",
    schedule: "Daily at 09:00 UTC",
    icon: Clock,
    status: "Active",
  },
  {
    id: "security-audit",
    title: "Security Vulnerability Scan",
    schedule: "Weekly on Mondays",
    icon: ShieldCheck,
    status: "Scheduled",
  },
  {
    id: "release-drafter",
    title: "Release Notes Drafter",
    schedule: "Triggered on version tag",
    icon: Zap,
    status: "Ready",
  },
  {
    id: "memory-sync",
    title: "Vector Memory Sync",
    schedule: "Continuous sync",
    icon: Brain,
    status: "Syncing",
  },
];

const RAIL_MORE_ITEMS: { id: AppNavView; label: string; icon: LucideIcon }[] = (
  [
    { id: "integrations", label: "Extensions", icon: Blocks },
    { id: "inbox", label: "Mailbox", icon: Inbox },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "automations", label: "Automations", icon: Zap },
    { id: "dashboard", label: "Insights", icon: LayoutDashboard },
  ] as { id: AppNavView; label?: string; icon: LucideIcon }[]
).map(({ id, label, icon }) => ({
  id,
  icon,
  label: label ?? APP_NAV_ITEMS.find((item) => item.id === id)?.label ?? id,
}));

const AGENTS_VIEWS: AppNavView[] = ["custom-agents", "employee-tools", "swarm", "tasks"];
const CHATS_VIEWS: AppNavView[] = ["threads", "collaboration"];

export function railItemForView(view: AppNavView): "work" | "agents" | "chats" | "insights" | "more" | "settings" {
  if (view === "work") return "work";
  if (view === "settings") return "settings";
  if (AGENTS_VIEWS.includes(view)) return "agents";
  if (CHATS_VIEWS.includes(view)) return "chats";
  if (["dashboard", "analytics", "activity", "approvals", "diff"].includes(view)) return "insights";
  return "more";
}

export function AppNavRail({
  activeView,
  onNavigate,
  sidebarPanelId,
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
  workspaceSwitcher,
  workspaces,
  selectedWorkspaceId = "",
  onSelectWorkspace,
  remoteLabel,
}: AppNavRailProps): JSX.Element {
  const [needsApprovalOpen, setNeedsApprovalOpen] = useState(true);
  const [everythingOpen, setEverythingOpen] = useState(true);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [sidebarView, setSidebarView] = useState<"agents" | "workflows">("agents");

  const moreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const teamRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationId = useId();
  const restoreToggleFocus = useRef(false);
  const identity = workspaceLabel(accountEmail);

  useEffect(() => {
    if (variant === "rail" && restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      navigationRef.current?.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")?.focus();
    }
  }, [collapsed, variant]);

  function toggleSidebar() {
    restoreToggleFocus.current = true;
    onToggleCollapse?.();
  }

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
      if (teamRef.current && !teamRef.current.contains(e.target as Node)) {
        setTeamMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      for (const [ref, close] of [
        [moreRef, setMoreMenuOpen],
        [accountRef, setAccountMenuOpen],
        [teamRef, setTeamMenuOpen],
      ] as const) {
        const trigger = ref.current?.querySelector<HTMLElement>("[aria-haspopup]");
        if (trigger?.getAttribute("aria-expanded") === "true") {
          close(false);
          trigger.focus();
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
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
    "activity",
    "analytics",
    "approvals",
    "swarm",
    "collaboration",
    "team",
    "providers",
    "spaces",
    "employee-tools",
    "remote",
    "settings",
  ];

  const isMoreViewActive = moreViews.includes(activeView);

  // Persistent labeled navigation keeps primary destinations discoverable on every view.
  if (variant === "rail") {
    const activeRailItem = railItemForView(activeView);
    const railBtnBase = "shiba-app-rail-button rounded-lg flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] relative";
    const railBtnActive = "bg-[#e4e4e7] text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100 font-medium shadow-none";
    const railBtnInactive = "text-[#71717a] dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5";

    return (
      <aside
        ref={navigationRef}
        id={navigationId}
        className="shiba-app-rail hidden lg:flex w-[72px] shrink-0 flex-col items-center justify-between py-3 select-none h-full bg-transparent z-40"
        aria-label="Primary Left Rail"
        onFocusCapture={() => { restoreToggleFocus.current = true; }}
        onBlurCapture={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
            restoreToggleFocus.current = false;
          }
        }}
      >
        <div className="w-full h-full flex flex-col items-center justify-between">
          {/* Brand and the primary work destinations stay in one stable position. */}
          <div className="flex flex-col items-center gap-4 w-full">
            <Tooltip content="Shiba Home" side="right">
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate("work");
                }}
                aria-label="Shiba Home"
                className="size-9 rounded-full flex items-center justify-center hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
              >
                <ShibaMark className="size-7 rounded-full object-contain" />
              </a>
            </Tooltip>

            <nav aria-label="App Icon Rail" className="w-full">
              <ul className="shiba-app-rail-nav flex flex-col items-center gap-1 w-full list-none p-0 m-0">
                {/* Work */}
                <li>
                  <Tooltip content="Work" side="right">
                    <button
                      type="button"
                      onClick={() => onNavigate("work")}
                      aria-label="Work"
                      aria-current={activeRailItem === "work" ? "page" : undefined}
                      className={`${railBtnBase} ${activeRailItem === "work" ? railBtnActive : railBtnInactive}`}
                    >
                      <ListChecks className="size-5" strokeWidth={1.8} aria-hidden="true" />
                      <span className="shiba-app-rail-label">Work</span>
                    </button>
                  </Tooltip>
                </li>

                {/* Agents */}
                <li>
                  <Tooltip content="Agents" side="right">
                    <button
                      type="button"
                      onClick={() => onNavigate("custom-agents")}
                      aria-label="Agents"
                      aria-current={activeRailItem === "agents" ? "page" : undefined}
                      className={`${railBtnBase} ${activeRailItem === "agents" ? railBtnActive : railBtnInactive}`}
                    >
                      <Bot className="size-5" strokeWidth={1.8} aria-hidden="true" />
                      <span className="shiba-app-rail-label">Agents</span>
                    </button>
                  </Tooltip>
                </li>

                {/* Chats */}
                <li>
                  <Tooltip content="Chats" side="right">
                    <button
                      type="button"
                      onClick={() => onNavigate("threads")}
                      aria-label="Chats"
                      aria-current={activeRailItem === "chats" ? "page" : undefined}
                      className={`${railBtnBase} ${activeRailItem === "chats" ? railBtnActive : railBtnInactive}`}
                    >
                      <MessagesSquare className="size-5" strokeWidth={1.8} aria-hidden="true" />
                      <span className="shiba-app-rail-label">Chats</span>
                    </button>
                  </Tooltip>
                </li>

                <li>
                  <Tooltip content={pendingApprovalCount > 0 ? `Insights · ${pendingApprovalCount} pending approvals` : "Insights"} side="right">
                    <button
                      type="button"
                      onClick={() => onNavigate("dashboard")}
                      aria-label="Insights"
                      aria-current={activeRailItem === "insights" ? "page" : undefined}
                      className={`${railBtnBase} ${activeRailItem === "insights" ? railBtnActive : railBtnInactive}`}
                    >
                      <LayoutDashboard className="size-5" strokeWidth={1.8} aria-hidden="true" />
                      <span className="shiba-app-rail-label">Insights</span>
                      {pendingApprovalCount > 0 ? <span role="status" className="shiba-app-rail-badge" aria-label={`${pendingApprovalCount} pending approvals`}>{pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}</span> : null}
                    </button>
                  </Tooltip>
                </li>

                {/* More (...) */}
                <li>
                  <div ref={moreRef} className="relative">
                    <Tooltip content="More" side="right">
                      <button
                        type="button"
                        onClick={() => setMoreMenuOpen((prev) => !prev)}
                        aria-label="More"
                        aria-expanded={moreMenuOpen}
                        aria-haspopup="true"
                        aria-current={activeRailItem === "more" ? "page" : undefined}
                        className={`${railBtnBase} ${activeRailItem === "more" ? railBtnActive : railBtnInactive}`}
                      >
                        <MoreHorizontal className="size-5" strokeWidth={1.8} aria-hidden="true" />
                        <span className="shiba-app-rail-label">More</span>
                      </button>
                    </Tooltip>

                    {moreMenuOpen ? (
                      <div
                        className="absolute left-full top-0 ml-2 w-56 py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 text-[13px] max-h-[75vh] overflow-y-auto animate-enter"
                      >
                        <div role="menu" aria-label="Additional views">
                          {RAIL_MORE_ITEMS.map((item) => {
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  onNavigate(item.id);
                                  setMoreMenuOpen(false);
                                }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]"
                              >
                                <Icon className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
                                <span className="flex-1 truncate">{item.label}</span>
                                {item.id === "dashboard" && pendingApprovalCount > 0 ? (
                                  <span className="min-w-4 h-4 px-1 bg-[var(--warning-subtle)] text-[var(--warning-fg)] text-[10px] font-bold flex items-center justify-center rounded">
                                    {pendingApprovalCount}
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              </ul>
            </nav>
          </div>

          {/* Bottom Stack: sidebar-toggle, theme, help, settings, user avatar square */}
          <div className="flex flex-col items-center gap-1.5 mt-auto w-full">
            {onToggleCollapse ? (
              <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut="⌘B" side="right">
                <button
                  type="button"
                  data-sidebar-toggle
                  onClick={toggleSidebar}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-expanded={!collapsed}
                  aria-controls={sidebarPanelId ? (collapsed ? undefined : sidebarPanelId) : navigationId}
                  className={`${railBtnBase} ${railBtnInactive}`}
                >
                  <PanelLeft className="size-5" strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}

            {onToggleTheme ? (
              <Tooltip content={theme === "dark" ? "Light theme" : "Dark theme"} side="right">
                <button
                  type="button"
                  onClick={onToggleTheme}
                  aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                  className={`${railBtnBase} ${railBtnInactive}`}
                >
                  {theme === "dark" ? (
                    <Sun className="size-5" strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <Moon className="size-5" strokeWidth={1.8} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            ) : null}

            {onOpenShortcuts ? (
              <Tooltip content="Help & Shortcuts" shortcut="?" side="right">
                <button
                  type="button"
                  onClick={onOpenShortcuts}
                  aria-label="Help & shortcuts"
                  className={`${railBtnBase} ${railBtnInactive}`}
                >
                  <HelpCircle className="size-5" strokeWidth={1.8} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}

            <Tooltip content="Settings" side="right">
              <button
                type="button"
                onClick={() => onNavigate("settings")}
                aria-label="Settings"
                aria-current={activeRailItem === "settings" ? "page" : undefined}
                className={`${railBtnBase} ${activeRailItem === "settings" ? railBtnActive : railBtnInactive}`}
              >
                <Settings className="size-5" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </Tooltip>

            <div ref={accountRef} className="relative">
              <Tooltip content={identity.name || "Workspace profile"} side="right">
                <button
                  type="button"
                  onClick={() => setAccountMenuOpen((prev) => !prev)}
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="true"
                  aria-label={accountEmail ? `${accountEmail} · workspace` : "Workspace profile"}
                  className="size-[38px] rounded-lg border border-[var(--border-1)] bg-[var(--card)] flex items-center justify-center overflow-hidden hover:opacity-90 transition-opacity focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                >
                  <ShibaMark className="size-6 object-contain" />
                </button>
              </Tooltip>

              {accountMenuOpen ? (
                <div
                  className="absolute left-full bottom-0 ml-2 w-56 py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 text-[13px] animate-enter"
                >
                  <div className="px-3 py-2 border-b border-[var(--border-1)]">
                    <span className="block font-medium text-[var(--fg)] text-xs truncate">
                      {identity.name}
                    </span>
                    <span className="block text-[10px] text-[var(--muted-foreground-3)] truncate mt-0.5">
                      {identity.detail}
                    </span>
                  </div>

                  {workspaces && onSelectWorkspace ? (
                    <WorkspaceMenuList
                      workspaces={workspaces}
                      selectedWorkspaceId={selectedWorkspaceId}
                      onSelect={(id) => {
                        onSelectWorkspace(id);
                        setAccountMenuOpen(false);
                      }}
                      onCreate={() => {
                        onNavigate("team");
                        setAccountMenuOpen(false);
                      }}
                    />
                  ) : workspaceSwitcher ? (
                    <div className="px-2 py-1.5 border-b border-[var(--border-1)]">
                      {workspaceSwitcher}
                    </div>
                  ) : null}

                  <div className="px-3 py-1.5 text-[11px] text-[var(--muted-foreground-2)] border-b border-[var(--border-1)] flex items-center justify-between">
                    <span>Sandboxes</span>
                    <span className="font-mono font-medium">{activeSandboxCount} active</span>
                  </div>

                  <div role="menu" aria-label="Account actions">
                    {setupDone !== null && onOpenSetup ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onOpenSetup();
                          setAccountMenuOpen(false);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                      >
                        <span>Setup</span>
                        <span className="text-[11px] text-[var(--primary)] font-mono">
                          {setupDone}/{setupTotal}
                        </span>
                      </button>
                    ) : null}

                    <button
                      type="button"
                      role="menuitem"
                      aria-label="Remote access"
                      onClick={() => {
                        onNavigate("remote");
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                    >
                      <span>Remote access</span>
                      <span className="text-[10px] font-mono text-[var(--muted-foreground-3)]">{remoteLabel ?? "fleet"}</span>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onNavigate("settings");
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                    >
                      <span>Settings</span>
                      <Settings className="size-3.5 text-[var(--muted-foreground-3)]" />
                    </button>

                    {onSignOut ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onSignOut();
                          setAccountMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-[var(--destructive-fg)] hover:bg-[var(--destructive-soft)] transition-colors border-t border-[var(--border-1)] mt-1 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                      >
                        <LogOut className="size-3.5" />
                        <span>Sign out</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={navigationRef}
      id={navigationId}
      className={
        variant === "sheet"
          ? "w-[280px] max-w-[85vw] h-full flex flex-col bg-[var(--chrome)] text-[var(--fg)] border-r border-[var(--border-1)] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none overflow-hidden"
          : "hidden lg:flex h-full select-none"
      }
      aria-label="Primary Left Rail"
      onFocusCapture={() => { restoreToggleFocus.current = true; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          restoreToggleFocus.current = false;
        }
      }}
    >
      {/* Workspace Sidebar: expanded when variant === "sheet" or !collapsed */}
      {variant === "sheet" || !collapsed ? (
        <div
          className={
            variant === "sheet"
              ? "flex-1 flex flex-col min-h-0 overflow-hidden"
              : "h-full flex flex-col bg-[var(--chrome)] text-[var(--fg)] z-30 select-none overflow-hidden w-[248px] shrink-0 border-r border-[var(--border-1)] py-3 px-3"
          }
        >
          {/* TOPBAR: Team Selector Dropdown + Search + Collapse Button */}
          <div className="flex shrink-0 items-center justify-between px-1 pb-3 mb-1">
            <div ref={teamRef} className="relative flex items-center min-w-0">
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate("work");
                  if (variant === "sheet") onClose?.();
                }}
                className="flex items-center gap-2 group focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 rounded-md min-w-0"
                aria-label="Shiba Home"
              >
                <ShibaMark className="size-7" />
                <span className="font-display text-[24px] text-[var(--fg)] tracking-tight leading-none select-none">
                  Shiba
                </span>
              </a>
              <button
                type="button"
                onClick={() => setTeamMenuOpen((prev) => !prev)}
                aria-label="Team workspace menu"
                aria-expanded={teamMenuOpen}
                aria-haspopup="true"
                className="ml-1 p-1 rounded hover:bg-[var(--secondary)] text-[var(--muted-foreground-3)] hover:text-[var(--fg)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
              >
                <ChevronDown className="size-3.5" />
              </button>

              {teamMenuOpen ? (
                <div
                  role="menu"
                  className="absolute left-0 top-full mt-1 w-52 py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 text-[13px] animate-enter"
                >
                  <div className="px-3 py-1.5 border-b border-[var(--border-1)]">
                    <p className="font-medium text-xs text-[var(--fg)] truncate">{identity.name}</p>
                    <p className="text-[10px] text-[var(--muted-foreground-3)] truncate">{identity.detail}</p>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNavigate("custom-agents");
                      setTeamMenuOpen(false);
                      if (variant === "sheet") onClose?.();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]"
                  >
                    <Bot className="size-4 text-[var(--icon-muted)]" />
                    <span>Manage agents</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNavigate("settings");
                      setTeamMenuOpen(false);
                      if (variant === "sheet") onClose?.();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)]"
                  >
                    <Settings className="size-4 text-[var(--icon-muted)]" />
                    <span>Workspace settings</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-1 ml-auto">
              {onOpenSearch ? (
                <Tooltip content="Search" shortcut="⌘K" side="bottom">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSearch();
                      if (variant === "sheet") onClose?.();
                    }}
                    aria-label="Search"
                    className="size-8 min-h-[44px] min-w-[44px] rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
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
                  className="size-8 min-h-[44px] min-w-[44px] rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
                >
                  <X className="size-4" strokeWidth={1.8} aria-hidden="true" />
                </button>
              ) : onToggleCollapse ? (
                <Tooltip content="Collapse sidebar" shortcut="⌘B" side="bottom">
                  <button
                    type="button"
                    data-sidebar-toggle
                    onClick={toggleSidebar}
                    aria-label="Collapse sidebar"
                    aria-expanded={true}
                    aria-controls={navigationId}
                    className="size-8 min-h-[44px] min-w-[44px] rounded-lg flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
                  >
                    <PanelLeft className="size-4" strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>

          {/* View Switcher: Agents | Workflows */}
          {workspaceSwitcher}
          <div className="grid grid-cols-2 p-0.5 rounded-lg bg-[var(--secondary)] mb-2.5 text-xs font-medium shrink-0">
            <button
              type="button"
              aria-pressed={sidebarView === "agents"}
              aria-label="Switch to agents"
              onClick={() => setSidebarView("agents")}
              className={`py-1.5 rounded-md flex items-center justify-center gap-1.5 transition-all focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
                sidebarView === "agents"
                  ? "bg-[var(--card)] text-[var(--fg)] shadow-sm font-medium"
                  : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
              }`}
            >
              <Bot className="size-3.5" aria-hidden="true" />
              <span>Agents</span>
            </button>
            <button
              type="button"
              aria-pressed={sidebarView === "workflows"}
              aria-label="Switch to workflows"
              onClick={() => setSidebarView("workflows")}
              className={`py-1.5 rounded-md flex items-center justify-center gap-1.5 transition-all focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
                sidebarView === "workflows"
                  ? "bg-[var(--card)] text-[var(--fg)] shadow-sm font-medium"
                  : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
              }`}
            >
              <Workflow className="size-3.5" aria-hidden="true" />
              <span>Workflows</span>
            </button>
          </div>

          {/* SCROLLING REGION FOR SIDEBAR NAVIGATION */}
          <div role="region" aria-label="Sidebar navigation" className="min-h-0 flex-1 overflow-y-auto">
            {/* Header Action: New thread */}
            <p className="px-3 pb-2 text-xs text-[var(--muted-foreground-2)]">Workspace</p>
            <button
              type="button"
              onClick={() => {
                if (onNewTask) onNewTask();
                else onNavigate("tasks");
                if (variant === "sheet") onClose?.();
              }}
              className="mb-3 flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--secondary)] px-3 text-sm text-[var(--fg)] hover:bg-[var(--secondary-hover)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            >
              <SquarePen aria-hidden="true" className="size-4" />
              New thread
            </button>

            {sidebarView === "workflows" ? (
              <section aria-label="Workflows & Automations" className="flex flex-col gap-1 mb-4">
                <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
                  <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-[var(--muted-foreground-2)]">
                    Routines
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onNavigate("automations");
                      if (variant === "sheet") onClose?.();
                    }}
                    className="text-[11px] text-[var(--primary)] hover:underline"
                  >
                    Manage
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  {CURATED_WORKFLOWS.map((wf) => {
                    const Icon = wf.icon;
                    return (
                      <div
                        key={wf.id}
                        className="group flex items-center justify-between p-2 rounded-lg hover:bg-[var(--secondary)] transition-colors border border-transparent hover:border-[var(--border-1)]"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="p-1.5 rounded-md bg-[var(--card)] border border-[var(--border-1)] text-[var(--icon-muted)] group-hover:text-[var(--fg)] shrink-0">
                            <Icon className="size-3.5" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1 leading-tight">
                            <p className="text-[13px] font-medium text-[var(--fg)] truncate">{wf.title}</p>
                            <p className="text-[10px] text-[var(--muted-foreground-3)] truncate mt-0.5">{wf.schedule}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onNavigate("automations");
                            if (variant === "sheet") onClose?.();
                          }}
                          aria-label={`Run ${wf.title}`}
                          className="opacity-0 group-hover:opacity-100 px-2 py-0.5 text-[10px] font-medium rounded border border-[var(--border-1)] bg-[var(--card)] text-[var(--fg)] hover:bg-[var(--secondary-hover)] transition-all shrink-0"
                        >
                          Run
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* MAIN NAV ITEMS */}
            <nav aria-label="Main" className="flex flex-col gap-0.5 mb-3 px-0.5">
              <button
                type="button"
                onClick={() => {
                  onNavigate("work");
                  if (variant === "sheet") onClose?.();
                }}
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

              <button
                type="button"
                onClick={() => {
                  onNavigate("custom-agents");
                  if (variant === "sheet") onClose?.();
                }}
                aria-current={activeView === "custom-agents" ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${
                  activeView === "custom-agents" ? "bg-[var(--secondary)] text-[var(--fg)] font-medium" : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)]"
                }`}
              >
                <Bot aria-hidden="true" className="size-4 text-[var(--icon-muted)]" />
                <span>Agents</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onNavigate("tasks");
                  if (variant === "sheet") onClose?.();
                }}
                aria-current={activeView === "tasks" ? "page" : undefined}
                className={
                  "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
                  (activeView === "tasks"
                    ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
                    : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
                }
              >
                <List className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
                <span className="flex-1 text-left truncate leading-none">Tasks</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onNavigate("threads");
                  if (variant === "sheet") onClose?.();
                }}
                aria-current={activeView === "threads" ? "page" : undefined}
                className={
                  "w-full flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] h-11 text-[14px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 " +
                  (activeView === "threads"
                    ? "text-[var(--fg)] bg-[var(--secondary)] font-medium"
                    : "text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--section)]")
                }
              >
                <MessagesSquare className="size-4 shrink-0 text-[var(--icon-muted)]" strokeWidth={1.8} aria-hidden="true" />
                <span className="flex-1 text-left truncate leading-none">Threads</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onNavigate("diff");
                  if (variant === "sheet") onClose?.();
                }}
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

              <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--muted-foreground-3)]">Explore</p>
              {RAIL_MORE_ITEMS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onNavigate(id);
                    if (variant === "sheet") onClose?.();
                  }}
                  aria-current={activeView === id ? "page" : undefined}
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                    activeView === id
                      ? "bg-[var(--secondary)] text-[var(--fg)] font-medium"
                      : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)] hover:text-[var(--fg)]"
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-[var(--icon-muted)]" />
                  <span>{label}</span>
                </button>
              ))}

              <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--muted-foreground-3)]">Resources</p>
              {(["skills", "agents"] as const).map((id) => {
                const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
                if (!item) return null;
                const Icon = ICONS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onNavigate(id);
                      if (variant === "sheet") onClose?.();
                    }}
                    aria-current={activeView === id ? "page" : undefined}
                    title={item.description}
                    className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${
                      activeView === id
                        ? "bg-[var(--secondary)] text-[var(--fg)] font-medium"
                        : "text-[var(--muted-foreground-2)] hover:bg-[var(--section)] hover:text-[var(--fg)]"
                    }`}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-[var(--icon-muted)]" />
                    <span>{item.label}</span>
                  </button>
                );
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
                            if (variant === "sheet") onClose?.();
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

            {/* AGENTS LIST SECTION */}
            {onNewAgentThread ? (
              <AgentSidebar
                agents={customAgentRecords}
                threads={agentThreads}
                selectedId={selectedSessionId}
                onOpenThread={(id) => {
                  onSelectSession?.(id);
                  if (variant === "sheet") onClose?.();
                }}
                onNewThread={(agent) => {
                  onNewAgentThread(agent);
                  if (variant === "sheet") onClose?.();
                }}
                onManage={() => {
                  onNavigate("custom-agents");
                  if (variant === "sheet") onClose?.();
                }}
              />
            ) : null}

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
                        onClick={() => {
                          onSelectSession?.(s.id);
                          if (variant === "sheet") onClose?.();
                        }}
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

            {/* COLLAPSIBLE GROUP: Everything (Threads List) */}
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
                    onClick={() => {
                      setSearchOpen((prev) => !prev);
                      setEverythingOpen(true);
                    }}
                    aria-label="Search threads"
                    aria-expanded={searchOpen && everythingOpen}
                    aria-controls={`thread-search-${variant}`}
                    className="size-6 min-h-11 min-w-11 rounded flex items-center justify-center text-[var(--icon-muted)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
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
                              if (variant === "sheet") onClose?.();
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

          {/* BOTTOM MACHINE / RUNTIME STATUS CARD */}
          <div className="shrink-0 pt-2 px-1 text-xs text-[var(--muted-foreground-2)] border-t border-[var(--border-1)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--muted-foreground-2)]">
                <span className="size-2 rounded-full bg-[var(--success)] shrink-0" aria-hidden="true" />
                <span>Cloudflare Worker</span>
              </span>
              <span className="text-[10px] font-mono text-[var(--muted-foreground-3)]">Online</span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <p className="py-0.5">{activeSandboxCount} active sandboxes</p>
              {setupDone !== null && onOpenSetup ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenSetup();
                    if (variant === "sheet") onClose?.();
                  }}
                  className="rounded px-1 text-[var(--primary)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                >
                  Setup {setupDone}/{setupTotal}
                </button>
              ) : null}
            </div>
          </div>

          {/* FOOTER USER / WORKSPACE CARD */}
          <div className="pt-2 mt-1 shrink-0 border-t border-[var(--border-1)] flex flex-col gap-1">
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
                  className="absolute left-0 bottom-full mb-1 w-full py-1 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-overlay z-50 text-[13px] animate-enter"
                >
                  <div className="px-3 py-1.5 border-b border-[var(--border-1)]">
                    <span className="block font-medium text-[var(--fg)] text-xs truncate">
                      {identity.name}
                    </span>
                    <span className="block text-[10px] text-[var(--muted-foreground-3)] truncate mt-0.5">
                      {identity.detail}
                    </span>
                  </div>
                  {onToggleTheme ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onToggleTheme();
                        setAccountMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                    >
                      <span>Theme</span>
                      <span className="text-[11px] font-mono text-[var(--muted-foreground-3)] capitalize">
                        {theme ?? "system"}
                      </span>
                    </button>
                  ) : null}
                  {onOpenShortcuts ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onOpenShortcuts();
                        setAccountMenuOpen(false);
                        if (variant === "sheet") onClose?.();
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                    >
                      <span>Shortcuts</span>
                      <span className="text-[10px] font-mono text-[var(--muted-foreground-3)]">?</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Remote access"
                    onClick={() => {
                      onNavigate("remote");
                      setAccountMenuOpen(false);
                      if (variant === "sheet") onClose?.();
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                  >
                    <span>Remote access</span>
                    <span className="text-[10px] font-mono text-[var(--muted-foreground-3)]">fleet</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNavigate("settings");
                      setAccountMenuOpen(false);
                      if (variant === "sheet") onClose?.();
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--popover-hover)] transition-colors"
                  >
                    <span>Settings</span>
                    <Settings className="size-3.5 text-[var(--muted-foreground-3)]" />
                  </button>
                  {onSignOut ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSignOut();
                        setAccountMenuOpen(false);
                        if (variant === "sheet") onClose?.();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[var(--destructive-fg)] hover:bg-[var(--destructive-soft)] transition-colors border-t border-[var(--border-1)] mt-1 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                    >
                      <LogOut className="size-3.5" />
                      <span>Sign out</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
