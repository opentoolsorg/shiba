/**
 * AppNavRail — left app sidebar (224px, all views, lg+). Below lg the same
 * nav renders as a slide-in sheet (`variant="sheet"`) opened from the top bar.
 * Bezalel-style: logo block on top, grouped text nav with navy active
 * state, utility cluster (setup, docs, shortcuts, theme) at the bottom.
 */
import type { JSX } from "react";
import {
  Activity,
  BarChart3,
  Blocks,
  BookMarked,
  BookOpen,
  Brain,
  Cpu,
  GitCompareArrows,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  Sun,
  Terminal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type AppNavView =
  | "dashboard"
  | "tasks"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
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
  { id: "tasks", label: "Tasks", description: "Tasks & Live Sessions" },
  { id: "activity", label: "Activity", description: "Orchestrator Event Log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "diff", label: "Diff", description: "Code Changes & Git Diffs" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
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

const NAV_GROUPS: { label: string; items: AppNavView[] }[] = [
  { label: "Workspace", items: ["dashboard", "tasks", "activity", "analytics", "diff", "approvals", "automations"] },
  { label: "Capabilities", items: ["agents", "providers", "skills", "integrations", "inbox", "memory"] },
  { label: "System", items: ["remote", "settings"] },
];

export interface AppNavRailProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  activeSandboxCount: number;
  pendingApprovalCount?: number;
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onOpenShortcuts: () => void;
  variant?: "rail" | "sheet";
  /** Sheet only: renders a close button in the brand row. */
  onClose?: () => void;
  /** Built-in auth lane: signed-in identity + sign-out affordance. */
  accountEmail?: string | null;
  onSignOut?: () => void;
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
};

function NavItem({
  label,
  subLabel,
  active,
  onClick,
  children,
  badge,
}: {
  label: string;
  subLabel?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const accessibleLabel = subLabel ? `${label} ${subLabel}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      aria-current={active ? "page" : undefined}
      className={
        "group w-full flex items-center gap-2.5 rounded-none px-2.5 py-1.5 touch:min-h-11 text-[13px] font-medium transition-colors duration-100 " +
        (active
          ? "bg-[#0000a8] dark:bg-[#9cbce2] text-white dark:text-[#152335] shadow-[2px_2px_0_var(--paper-shadow)]"
          : "text-[#222320] dark:text-[#eae8e1] hover:bg-[#e0ded5] dark:hover:bg-[#3b3d36] hover:text-[#222320] dark:hover:text-[#f4f2ea]")
      }
    >
      <span className={active ? "text-white dark:text-[#152335]" : "text-[#6a6f63] dark:text-[#aaa99f] group-hover:text-[#222320] dark:group-hover:text-[#f4f2ea]"} aria-hidden="true">
        {children}
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block truncate">{label}</span>
        {subLabel ? (
          <span className="block truncate text-[11px] font-normal text-[#6a6f63] dark:text-[#aaa99f] group-hover:text-[#222320] dark:group-hover:text-[#f4f2ea]">
            {subLabel}
          </span>
        ) : null}
      </span>
      {badge}
    </button>
  );
}

export function AppNavRail({
  activeView,
  onNavigate,
  activeSandboxCount,
  pendingApprovalCount,
  setupDone,
  setupTotal,
  onOpenSetup,
  onOpenShortcuts,
  theme,
  onToggleTheme,
  variant = "rail",
  onClose,
  accountEmail,
  onSignOut,
}: AppNavRailProps): JSX.Element {
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;

  return (
    <nav
      className={
        variant === "sheet"
          ? "w-72 max-w-[85vw] h-full flex flex-col bg-[#f6f4ed] dark:bg-[#191a18] border-r border-[#e0ded5] dark:border-[#3b3d36] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] select-none overflow-y-auto"
          : "hidden lg:flex w-56 shrink-0 flex-col bg-[#f6f4ed] dark:bg-[#191a18] border-r border-[#e0ded5] dark:border-[#3b3d36] py-3 px-3 z-30 select-none overflow-y-auto"
      }
      aria-label="Primary"
    >
      <div className="flex items-start gap-2">
      {/* Brand */}
      <a href="/" className="flex-1 min-w-0 flex items-center gap-2.5 px-1.5 pb-3 mb-1 group focus:outline-none" aria-label="Shiba Home">
        <img
          src="/assets/mascot/pet-logo.png"
          alt="Shiba"
          className="size-8 rounded-full bg-white object-contain [image-rendering:pixelated] border border-[#d3d2c8] transition-transform duration-200 group-hover:scale-105"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="font-display text-lg leading-none text-[#222320] dark:text-[#eae8e1]">Shiba</span>
            <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-[#0000a8] border border-[#0000a8]/25 bg-[#0000a8]/10 rounded-none px-1 py-px">
              Beta
            </span>
          </span>
          <span className="block text-[11px] text-[#6a6f63] dark:text-[#aaa99f] leading-tight">agent plane</span>
        </span>
      </a>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="size-11 -mt-1.5 -mr-1.5 shrink-0 rounded-none flex items-center justify-center text-[#6a6f63] dark:text-[#aaa99f] hover:text-[#222320] dark:hover:text-[#f4f2ea] hover:bg-[#e0ded5] dark:hover:bg-[#3b3d36] transition-colors"
        >
          <X aria-hidden="true" className="size-5" strokeWidth={2} />
        </button>
      ) : null}
      </div>

      {/* Grouped primary nav */}
      <div className="flex flex-col gap-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63] dark:text-[#aaa99f]">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((id) => {
                const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
                if (!item) return null;
                const Icon = ICONS[item.id];
                return (
                  <NavItem
                    key={item.id}
                    label={item.label}
                    active={activeView === item.id}
                    onClick={() => onNavigate(item.id)}
                    badge={
                      item.id === "approvals" && pendingApprovalCount && pendingApprovalCount > 0 ? (
                        <span
                          className="min-w-4 h-4 px-1 rounded-none bg-[#b45309] text-white text-[9px] font-bold flex items-center justify-center"
                          aria-hidden="true"
                        >
                          {pendingApprovalCount}
                        </span>
                      ) : undefined
                    }
                  >
                    <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
                  </NavItem>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Utility cluster */}
      <div className="mt-auto flex flex-col gap-0.5 pt-3 mt-4 border-t border-[#e0ded5] dark:border-[#3b3d36]">
        <NavItem
          label={setupComplete ? "Setup Guide" : `Setup Guide · ${setupDone ?? 0}/${setupTotal}`}
          onClick={onOpenSetup}
          badge={
            !setupComplete && setupRemaining !== null ? (
              <span
                className="min-w-4 h-4 px-1 rounded-none bg-[#b45309] text-white text-[9px] font-bold flex items-center justify-center"
                aria-hidden="true"
              >
                {setupRemaining}
              </span>
            ) : undefined
          }
        >
          <SquareCheckBig className="size-4" strokeWidth={1.8} aria-hidden="true" />
        </NavItem>

        <a
          href="/docs/"
          aria-label="Documentation"
          className="group w-full flex items-center gap-2.5 rounded-none px-2.5 py-1.5 touch:min-h-11 text-[13px] font-medium text-[#222320] dark:text-[#eae8e1] hover:bg-[#e0ded5] dark:hover:bg-[#3b3d36] hover:text-[#222320] dark:hover:text-[#f4f2ea] transition-colors duration-100"
        >
          <span className="text-[#6a6f63] dark:text-[#aaa99f] group-hover:text-[#222320] dark:group-hover:text-[#f4f2ea]" aria-hidden="true">
            <BookOpen className="size-4" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="flex-1 text-left truncate">Documentation</span>
        </a>

        <NavItem label="Keyboard shortcuts" onClick={onOpenShortcuts}>
          <span className="text-[11px] font-mono font-bold leading-none">?</span>
        </NavItem>

        {onSignOut ? (
          <NavItem
            label="Sign out"
            subLabel={accountEmail ?? undefined}
            onClick={onSignOut}
          >
            <LogOut className="size-4" strokeWidth={1.8} aria-hidden="true" />
          </NavItem>
        ) : null}

        {onToggleTheme ? (
          <NavItem
            label={theme === "light" ? "Dark theme" : "Light theme"}
            onClick={onToggleTheme}
          >
            {theme === "light" ? (
              <Moon className="size-4" strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Sun className="size-4" strokeWidth={1.8} aria-hidden="true" />
            )}
          </NavItem>
        ) : null}
      </div>
    </nav>
  );
}
