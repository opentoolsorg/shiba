import { useEffect, useId, useRef, useState, type JSX, type ComponentPropsWithRef } from "react";
import {
  BookMarked,
  HelpCircle,
  ListChecks,
  MessagesSquare,
  Moon,
  PanelLeft,
  Search,
  Settings,
  Sun,
  Users,
  X,
} from "lucide-react";
import type { TeamWorkspaceSummary } from "@shiba/shared";
import type { SessionItem } from "./SessionsSidebar";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { WebThread } from "../agent-threads";
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { AgentSidebar } from "./AgentExperience";
import { ShibaMark } from "./ShibaMark";
import { WorkspaceMenuList } from "./WorkspaceSwitcher";
import {
  APP_AREAS,
  areaForView,
  pathForView,
  navigationLabel,
  type AppNavView,
} from "../app-navigation";
export { APP_NAV_ITEMS, type AppNavView } from "../app-navigation";
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

export function workspaceLabel(accountEmail: string | null | undefined): {
  name: string;
  detail: string;
} {
  const email = accountEmail?.trim();
  if (!email) return { name: "Signed in", detail: "This workspace" };
  if (email.includes("@")) {
    const name = email.split("@")[0] || email;
    return { name, detail: email };
  }
  return { name: email, detail: "This workspace" };
}

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

const AREA_ICONS = {
  work: ListChecks,
  chat: MessagesSquare,
  team: Users,
  knowledge: BookMarked,
  settings: Settings,
};

export function AppNavRail({
  activeView,
  onNavigate,
  sidebarPanelId,
  variant = "rail",
  collapsed = false,
  onToggleCollapse,
  onClose,
  pendingApprovalCount = 0,
  onOpenSearch,
  onNewTask,
  onOpenSetup,
  setupDone = null,
  setupTotal = 6,
  onOpenShortcuts,
  theme,
  onToggleTheme,
  accountEmail,
  onSignOut,
  activeSandboxCount = 0,
  workspaceSwitcher,
  workspaces,
  selectedWorkspaceId = "",
  onSelectWorkspace,
  remoteLabel,
  connectionLabel = "Connecting",
  connectionTone = "pending",
  sessions = [],
  selectedSessionId,
  onSelectSession,
  threadsLoading = false,
  customAgentRecords = [],
  agentThreads = [],
  onNewAgentThread,
}: AppNavRailProps): JSX.Element {
  const [accountOpen, setAccountOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const accountRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const restoreToggleFocus = useRef(false);
  const navigationId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const filteredSessions = sessions.filter((session) =>
    `${session.title} ${session.repoName}`.toLowerCase().includes(threadQuery.trim().toLowerCase()),
  );
  const identity = workspaceLabel(accountEmail);
  const activeArea = areaForView(activeView);
  const sheet = variant === "sheet";
  function go(view: AppNavView) {
    onNavigate(view);
    if (sheet) onClose?.();
  }
  useEffect(() => {
    if (restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      navigationRef.current
        ?.querySelector<HTMLButtonElement>(`[data-sidebar-toggle][aria-expanded="${!collapsed}"]`)
        ?.focus();
    }
  }, [collapsed]);
  useEffect(() => {
    function close(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !accountOpen) return;
      event.stopPropagation();
      setAccountOpen(false);
      accountRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [accountOpen]);
  useEffect(() => {
    if (!sheet) return;
    const panel = navigationRef.current;
    panel?.querySelector<HTMLElement>("a,button")?.focus();
    function trapFocus(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Let the account menu consume its own Escape before closing the drawer.
        if (panel?.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) return;
        event.preventDefault();
        onCloseRef.current?.();
      }
      if (event.key !== "Tab" || !panel) return;
      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]',
        ),
      );
      const first = stops[0],
        last = stops[stops.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [sheet]);
  function moveThread(key: string) {
    if (!onSelectSession || !filteredSessions.length) return;
    const current = filteredSessions.findIndex((session) => session.id === selectedSessionId);
    const last = filteredSessions.length - 1;
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowDown"
            ? Math.min(last, current + 1)
            : Math.max(0, current - 1);
    const next = filteredSessions[nextIndex];
    if (!next) return;
    onSelectSession(next.id);
    document.getElementById(`${navigationId}-thread-${next.id}`)?.focus();
  }
  return (
    <NavigationContainer
      sheet={sheet}
      ref={navigationRef}
      id={navigationId}
      aria-label={sheet ? "Workspace navigation" : "Primary Left Rail"}
      className={
        sheet
          ? "shiba-navigation-sheet"
          : "shiba-app-rail hidden lg:flex w-[72px] shrink-0 flex-col items-center py-3 h-full"
      }
      onFocusCapture={() => {
        restoreToggleFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          restoreToggleFocus.current = false;
      }}
    >
      <div className="flex w-full shrink-0 items-center justify-center gap-2 pb-3">
        <a
          href={pathForView("work")}
          onClick={(event) => {
            if (
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              go("work");
            }
          }}
          aria-label="Shiba Home"
          className="shiba-shell-icon"
        >
          <ShibaMark className="size-7" />
        </a>
        {sheet ? (
          <>
            <span className="mr-auto font-display text-2xl">Shiba</span>
            <button
              type="button"
              className="shiba-shell-icon"
              aria-label="Close sidebar"
              onClick={onClose}
            >
              <X className="size-5" />
            </button>
          </>
        ) : null}
      </div>
      {sheet ? <div className="shrink-0 pb-3">{workspaceSwitcher}</div> : null}
      <nav
        aria-label="Workspace areas"
        className={
          sheet ? "min-h-0 flex-1 overflow-y-auto" : "w-full min-h-0 flex-1 overflow-y-auto"
        }
      >
        {APP_AREAS.map((area) => {
          const Icon = AREA_ICONS[area.id];
          return (
            <div key={area.id} className={sheet ? "pb-2" : "flex justify-center"}>
              <button
                type="button"
                onClick={() => go(area.defaultView)}
                aria-label={area.label}
                aria-current={activeArea.id === area.id ? "page" : undefined}
                className={sheet ? "shiba-area-heading" : "shiba-app-rail-button shiba-area-button"}
              >
                <Icon className="size-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
                <span className={sheet ? "" : "shiba-app-rail-label"}>{area.label}</span>
                {area.id === "work" && pendingApprovalCount > 0 ? (
                  <span
                    role="status"
                    className="shiba-app-rail-badge"
                    aria-label={`${pendingApprovalCount} pending approvals`}
                  >
                    {pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}
                  </span>
                ) : null}
              </button>
              {sheet ? (
                <div className="pl-4">
                  {area.views.map((view) => (
                    <button
                      type="button"
                      key={view}
                      className="shiba-area-link"
                      aria-current={view === activeView ? "page" : undefined}
                      onClick={() => go(view)}
                    >
                      {navigationLabel(view)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {sheet && onNewAgentThread ? (
          <AgentSidebar
            agents={customAgentRecords}
            threads={agentThreads}
            selectedId={selectedSessionId}
            onOpenThread={(id) => {
              onSelectSession?.(id);
              onClose?.();
            }}
            onNewThread={(agent) => {
              onNewAgentThread(agent);
              onClose?.();
            }}
            onManage={() => go("custom-agents")}
          />
        ) : null}
        {sheet ? (
          <section aria-label="Threads" className="border-t border-[var(--border-1)] pt-3">
            <button
              type="button"
              className="shiba-area-link"
              onClick={() => {
                if (onNewTask) onNewTask();
                else onNavigate("tasks");
                onClose?.();
              }}
            >
              New thread
            </button>
            <label className="block px-2 text-xs">
              Search threads
              <input
                className="mt-2 min-h-11 w-full border border-[var(--border-1)] bg-[var(--card)] px-2"
                value={threadQuery}
                onChange={(event) => setThreadQuery(event.target.value)}
              />
            </label>
            {threadsLoading ? (
              <p role="status" className="p-2 text-xs">
                Loading threads…
              </p>
            ) : filteredSessions.length === 0 ? (
              <p className="p-2 text-xs text-[var(--muted-foreground-2)]">
                {threadQuery.trim() ? "No sessions match your search." : "No threads yet."}
              </p>
            ) : (
              <div
                role="listbox"
                aria-label="Threads"
                onKeyDown={(event) => {
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    moveThread(event.key);
                  }
                }}
              >
                {filteredSessions.map((session) => (
                  <button
                    type="button"
                    role="option"
                    id={`${navigationId}-thread-${session.id}`}
                    key={session.id}
                    aria-selected={session.id === selectedSessionId}
                    className="shiba-area-link"
                    onClick={() => {
                      onSelectSession?.(session.id);
                      onClose?.();
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${navStatusDotClass(session.status, session.live)}`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{session.title || "Untitled thread"}</span>
                      <span className="block truncate text-[10px] text-[var(--muted-foreground-3)]">
                        {[
                          statusLabel(session.status),
                          session.repoName,
                          session.updatedAt > 0 ? formatTimeAgo(session.updatedAt) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </nav>
      <div
        className={
          sheet
            ? "flex shrink-0 items-center justify-between border-t border-[var(--border-1)] pt-2"
            : "flex shrink-0 flex-col items-center gap-1 pt-2"
        }
      >
        {!sheet && onToggleCollapse ? (
          <button
            type="button"
            className="shiba-shell-icon"
            data-sidebar-toggle
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : (sidebarPanelId ?? navigationId)}
            onClick={() => {
              restoreToggleFocus.current = true;
              onToggleCollapse();
            }}
          >
            <PanelLeft className="size-5" />
          </button>
        ) : null}
        {onOpenSearch ? (
          <button
            type="button"
            className="shiba-shell-icon"
            aria-label="Search"
            onClick={() => {
              onOpenSearch();
              if (sheet) onClose?.();
            }}
          >
            <Search className="size-5" />
          </button>
        ) : null}
        {onToggleTheme ? (
          <button
            type="button"
            className="shiba-shell-icon"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={onToggleTheme}
          >
            {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </button>
        ) : null}
        {onOpenShortcuts ? (
          <button
            type="button"
            className="shiba-shell-icon"
            aria-label="Help & shortcuts"
            onClick={() => {
              onOpenShortcuts();
              if (sheet) onClose?.();
            }}
          >
            <HelpCircle className="size-5" />
          </button>
        ) : null}
        <div ref={accountRef} className="relative">
          <button
            type="button"
            className="shiba-shell-icon"
            aria-label={accountEmail ? `${accountEmail} · workspace` : "Workspace profile"}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen(!accountOpen)}
          >
            <ShibaMark className="size-6" />
          </button>
          {accountOpen ? (
            <div
              className={
                sheet ? "shiba-account-menu shiba-account-menu-sheet" : "shiba-account-menu"
              }
            >
              <div className="border-b border-[var(--border-1)] px-3 py-2 text-xs">
                <p className="truncate font-medium">{identity.name}</p>
                <p className="truncate text-[var(--muted-foreground-2)]">{identity.detail}</p>
                <p className="pt-2" data-tone={connectionTone}>
                  {connectionLabel}
                </p>
                <p>{activeSandboxCount} active sandboxes</p>
              </div>
              {workspaces && onSelectWorkspace ? (
                <WorkspaceMenuList
                  workspaces={workspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelect={(id) => {
                    onSelectWorkspace(id);
                    setAccountOpen(false);
                    if (sheet) onClose?.();
                  }}
                  onCreate={() => {
                    go("team");
                    setAccountOpen(false);
                  }}
                />
              ) : null}
              {!workspaces && workspaceSwitcher && !sheet ? (
                <div className="p-2">{workspaceSwitcher}</div>
              ) : null}
              <div role="menu" aria-label="Account actions">
                {onOpenSetup && setupDone !== null ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="shiba-area-link"
                    onClick={() => {
                      onOpenSetup();
                      setAccountOpen(false);
                      if (sheet) onClose?.();
                    }}
                  >
                    Setup {setupDone}/{setupTotal}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="shiba-area-link"
                  onClick={() => {
                    go("remote");
                    setAccountOpen(false);
                  }}
                >
                  Remote access<span className="ml-auto text-xs">{remoteLabel ?? "fleet"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="shiba-area-link"
                  onClick={() => {
                    go("settings");
                    setAccountOpen(false);
                  }}
                >
                  Settings
                </button>
                {onSignOut ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="shiba-area-link text-[var(--destructive-fg)]"
                    onClick={() => {
                      onSignOut();
                      setAccountOpen(false);
                      if (sheet) onClose?.();
                    }}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </NavigationContainer>
  );
}

function NavigationContainer({
  sheet,
  ...props
}: ComponentPropsWithRef<"aside"> & { sheet: boolean }) {
  return sheet ? <section {...props} role="dialog" aria-modal="true" /> : <aside {...props} />;
}
