import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Box,
  ChevronRight,
  Cpu,
  Download,
  GitBranch,
  Key,
  Laptop,
  Bell,
  Mail,
  Palette,
  Search,
  Server,
  ShieldCheck,
  Sliders,
  User,
  Users,
  Zap,
} from "lucide-react";
import type { AppNavView } from "./AppNavRail";
import {
  ContextPanel,
  MainCard,
  PanelGroup,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";
import {
  SETTINGS_SECTION_LABELS,
  SettingsSectionBody,
  type SettingsSectionId,
} from "./settings-sections";
import { TeamWorkspaceView, type TeamWorkspaceViewProps } from "./TeamWorkspaceView";
import { RemoteAccessView } from "./RemoteAccessView";

export type SettingsPageSectionId = SettingsSectionId | "team" | "remote";

export interface SettingsNavGroup {
  heading: string;
  items: {
    id: SettingsPageSectionId;
    label: string;
    blurb: string;
    icon: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean | "true" }>;
  }[];
}

export const SETTINGS_PAGE_NAV_GROUPS: SettingsNavGroup[] = [
  {
    heading: "Your account",
    items: [
      { id: "account", label: "Account", blurb: SETTINGS_SECTION_LABELS.account.blurb, icon: User },
      { id: "api-keys", label: "API keys", blurb: SETTINGS_SECTION_LABELS["api-keys"].blurb, icon: Key },
      { id: "appearance", label: "Appearance", blurb: SETTINGS_SECTION_LABELS.appearance.blurb, icon: Palette },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "team", label: "Team", blurb: "Members, invitations & roles", icon: Users },
      { id: "remote", label: "Remote access", blurb: "Connected computers & daemon", icon: Laptop },
      { id: "models", label: "Models", blurb: SETTINGS_SECTION_LABELS.models.blurb, icon: Cpu },
      { id: "sandbox", label: "Sandbox", blurb: SETTINGS_SECTION_LABELS.sandbox.blurb, icon: Box },
      { id: "repositories", label: "Repositories", blurb: SETTINGS_SECTION_LABELS.repositories.blurb, icon: GitBranch },
      { id: "environments", label: "Environments", blurb: SETTINGS_SECTION_LABELS.environments.blurb, icon: Server },
      { id: "slack-import", label: "Slack import", blurb: SETTINGS_SECTION_LABELS["slack-import"].blurb, icon: Download },
    ],
  },
  {
    heading: "Features",
    items: [
      { id: "automations", label: "Automations", blurb: SETTINGS_SECTION_LABELS.automations.blurb, icon: Zap },
      { id: "mailbox", label: "Mailbox", blurb: SETTINGS_SECTION_LABELS.mailbox.blurb, icon: Mail },
      { id: "notifications", label: "Notifications", blurb: SETTINGS_SECTION_LABELS.notifications.blurb, icon: Bell },
    ],
  },
  {
    heading: "Deployment",
    items: [
      { id: "experimental", label: "Experimental", blurb: SETTINGS_SECTION_LABELS.experimental.blurb, icon: Sliders },
      { id: "deployment", label: "Deployment", blurb: SETTINGS_SECTION_LABELS.deployment.blurb, icon: ShieldCheck },
    ],
  },
];

export interface SettingsPanelProps {
  active?: string;
  activeSection?: string;
  onSelect?: (section: string) => void;
  onSelectSection?: (section: string) => void;
  onBack?: () => void;
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  className?: string;
}

/**
 * SettingsPanel — Secondary contextual panel for Settings:
 * Title "Settings" with "← Back to app", a search box filtering section names,
 * and grouped PanelNavItems.
 */
export function SettingsPanel({
  active,
  activeSection,
  onSelect,
  onSelectSection,
  onBack,
  scope,
  onScopeChange,
  className = "",
}: SettingsPanelProps): JSX.Element {
  const currentActive = active ?? activeSection ?? "account";
  const handleSelect = useCallback(
    (id: string) => {
      onSelect?.(id);
      onSelectSection?.(id);
    },
    [onSelect, onSelectSection],
  );

  const [searchQuery, setSearchQuery] = useState("");
  const q = searchQuery.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!q) return SETTINGS_PAGE_NAV_GROUPS;
    return SETTINGS_PAGE_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.blurb.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q),
      ),
    })).filter((group) => group.items.length > 0);
  }, [q]);

  return (
    <ContextPanel
      title="Settings"
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
    >
      {/* Back to app navigation */}
      <div className="shrink-0 mb-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to app"
          className="flex items-center gap-2 text-xs font-medium text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 py-1.5 px-2.5 rounded-lg hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors w-full"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />
          <span>Back to app</span>
        </button>
      </div>

      {/* Search box filtering section names */}
      <div className="relative shrink-0 mb-3 px-1">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#71717a] dark:text-zinc-500 pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full h-8 pl-8 pr-2.5 text-xs rounded-lg border border-[#e4e4e7] dark:border-zinc-800 bg-[#f4f4f5]/60 dark:bg-zinc-900 text-[#0a0a0a] dark:text-zinc-100 placeholder-[#71717a] dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600"
        />
      </div>

      {/* Grouped section items */}
      <div className="flex-1 flex flex-col gap-3 overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <p className="text-xs text-[#71717a] dark:text-zinc-500 py-4 text-center">
            No settings matching &ldquo;{searchQuery}&rdquo;
          </p>
        ) : (
          filteredGroups.map((group) => (
            <PanelGroup key={group.heading} label={group.heading}>
              {group.items.map((item) => (
                <PanelNavItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={currentActive === item.id}
                  onClick={() => handleSelect(item.id)}
                />
              ))}
            </PanelGroup>
          ))
        )}
      </div>
    </ContextPanel>
  );
}

export interface SettingsPageProps extends Partial<TeamWorkspaceViewProps> {
  section?: string;
  initialSection?: string;
  onSectionChange?: (section: string) => void;
  onBack?: () => void;
  onNavigate?: (view: AppNavView) => void;
  onOpenSessions?: () => void;
  onFocusRestore?: () => void;
  onSignOut?: () => Promise<void>;
  scope?: Scope;
  onScopeChange?: (s: Scope) => void;
  /** When true, renders SettingsPanel + MainCard side by side. Defaults to false. */
  withPanel?: boolean;
  /** Show the section switcher at every width (the context panel is collapsed). Below lg it always shows. */
  showSectionSwitcher?: boolean;
  /** In a team workspace only Team settings apply; other sections show a notice with this action. */
  onOpenPersonalWorkspace?: () => void;
  /** When private data is not available, only Team settings render. */
  personalDataBlocked?: boolean;
  className?: string;
}

const SETTINGS_PAGE_SECTION_IDS: readonly string[] = SETTINGS_PAGE_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));

/** Returns `id` when it names a known settings section, otherwise "account". */
export function normalizeSettingsSection(id: string | null | undefined): string {
  return id && SETTINGS_PAGE_SECTION_IDS.includes(id) ? id : "account";
}

function getSectionLabel(id: string): string {
  if (id === "team") return "Team";
  if (id === "remote") return "Remote access";
  if (id in SETTINGS_SECTION_LABELS) {
    return SETTINGS_SECTION_LABELS[id as SettingsSectionId].label;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * SettingsPage — Full page Settings main view:
 * Renders the selected section inside MainCard with breadcrumb "Settings > <Section>",
 * each section as a structured card of rows.
 */
export function SettingsPage({
  section,
  initialSection = "account",
  onSectionChange,
  onBack,
  onNavigate,
  onSignOut,
  scope,
  onScopeChange,
  actorId,
  workspaceId,
  invitationToken,
  onInvitationAccepted,
  onSelectWorkspace,
  onChanged,
  onOpenChat,
  onOpenWork,
  onOpenApps,
  withPanel = false,
  showSectionSwitcher = false,
  onOpenPersonalWorkspace,
  personalDataBlocked = false,
  className = "",
}: SettingsPageProps): JSX.Element {
  const [internalSection, setInternalSection] = useState(initialSection);
  const activeSection = section ?? internalSection;

  const handleSectionChange = useCallback(
    (nextSection: string) => {
      setInternalSection(nextSection);
      onSectionChange?.(nextSection);
    },
    [onSectionChange],
  );

  const currentLabel = getSectionLabel(activeSection);

  const mainCardContent = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* 48px standard header row */}
      <header className="h-12 min-h-[48px] w-full px-5 flex items-center justify-between border-b border-[#e4e4e7] dark:border-zinc-800 shrink-0 bg-white dark:bg-[#121214] select-none">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="text-[#71717a] dark:text-zinc-400">Settings</span>
          <ChevronRight
            className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span
            className="font-semibold text-[#0a0a0a] dark:text-zinc-100 truncate"
            aria-current="page"
          >
            {currentLabel}
          </span>
        </nav>

        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="h-7 px-2.5 rounded-lg border border-[#e4e4e7] dark:border-zinc-800 text-xs font-medium text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors"
          >
            Back to app
          </button>
        ) : null}
      </header>

      {/* Compact section switcher: phones and a collapsed context panel */}
      <div className={`shrink-0 border-b border-[#e4e4e7] px-4 py-2 dark:border-zinc-800 ${showSectionSwitcher ? "" : "lg:hidden"}`}>
        <label className="flex items-center gap-2 text-xs text-[#71717a] dark:text-zinc-400">
          <span className="shrink-0">Section</span>
          <select
            aria-label="Settings section"
            value={SETTINGS_PAGE_SECTION_IDS.includes(activeSection) ? activeSection : "account"}
            onChange={(event) => handleSectionChange(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-[#e4e4e7] bg-white px-2 text-sm text-[#0a0a0a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {SETTINGS_PAGE_NAV_GROUPS.map((group) => (
              <optgroup key={group.heading} label={group.heading}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {/* Body content based on section */}
      <div className="flex-1 overflow-y-auto">
        {(onOpenPersonalWorkspace || personalDataBlocked) && activeSection !== "team" ? (
          <section aria-label="Personal workspace setting" className="m-6 max-w-xl text-sm text-[#0a0a0a] dark:text-zinc-100">
            <h2 className="text-base font-medium">Open this setting in your personal workspace</h2>
            <p className="mt-2 text-[#71717a] dark:text-zinc-400">{currentLabel} applies to your account or this deployment, not to the selected team.</p>
            {onOpenPersonalWorkspace ? <button
              type="button"
              onClick={onOpenPersonalWorkspace}
              className="mt-4 min-h-11 rounded-lg border border-[#e4e4e7] px-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] dark:border-zinc-800"
            >
              Switch to personal workspace
            </button> : null}
          </section>
        ) : activeSection === "team" ? (
          <TeamWorkspaceView
            actorId={actorId ?? null}
            workspaceId={workspaceId}
            invitationToken={invitationToken}
            onInvitationAccepted={onInvitationAccepted}
            onSelectWorkspace={onSelectWorkspace}
            onChanged={onChanged}
            onOpenChat={onOpenChat}
            onOpenWork={onOpenWork}
            onOpenApps={onOpenApps}
          />
        ) : activeSection === "remote" ? (
          <RemoteAccessView />
        ) : (
          <div className="max-w-4xl mx-auto p-6 lg:p-8 flex flex-col gap-6">
            <SettingsSectionBody
              section={activeSection as SettingsSectionId}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
            />
          </div>
        )}
      </div>
    </div>
  );

  if (withPanel) {
    return (
      <div className={`flex h-full w-full gap-2 p-2 overflow-hidden ${className}`.trim()}>
        <SettingsPanel
          active={activeSection}
          onSelect={handleSectionChange}
          onBack={onBack}
          scope={scope}
          onScopeChange={onScopeChange}
        />
        <MainCard className="h-full">{mainCardContent}</MainCard>
      </div>
    );
  }

  return mainCardContent;
}
