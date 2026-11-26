import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type JSX,
} from "react";
import {
  ArrowLeft,
  Box,
  Building2,
  ChevronRight,
  Cpu,
  Download,
  GitBranch,
  Key,
  Webhook,
  Laptop,
  LayoutGrid,
  Bell,
  Mail,
  Palette,
  Plug,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Zap,
} from "lucide-react";
import { pathForView, type AppNavView } from "../app-navigation";
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
import { GroupsSettings } from "./settings/Groups";
import { SharingSettings } from "./settings/Sharing";
import { ArchivedSettings } from "./settings/Archived";
import { AdminSettings } from "./settings/Admin";

export type SettingsPageSectionId = SettingsSectionId | "overview" | "team" | "remote" | "groups" | "sharing" | "archived" | "admin";

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
    heading: "Start here",
    items: [
      { id: "overview", label: "Overview", blurb: "Settings categories & approval boundary", icon: LayoutGrid },
    ],
  },
  {
    heading: "Your account",
    items: [
      { id: "providers", label: "Providers", blurb: SETTINGS_SECTION_LABELS.providers.blurb, icon: Cpu },
      { id: "account", label: "Account", blurb: SETTINGS_SECTION_LABELS.account.blurb, icon: User },
      { id: "api-keys", label: "API keys", blurb: SETTINGS_SECTION_LABELS["api-keys"].blurb, icon: Key },
      { id: "webhooks", label: "Webhooks", blurb: SETTINGS_SECTION_LABELS.webhooks.blurb, icon: Webhook },
      { id: "appearance", label: "Appearance", blurb: SETTINGS_SECTION_LABELS.appearance.blurb, icon: Palette },
      { id: "connected-apps", label: "Connected apps", blurb: SETTINGS_SECTION_LABELS["connected-apps"].blurb, icon: ShieldCheck },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "team", label: "Team", blurb: "Members, invitations & roles", icon: Users },
      { id: "groups", label: "Groups", blurb: "Authorization groups & grants", icon: Users },
      { id: "sharing", label: "Sharing", blurb: "Public links & guest policy", icon: ShieldCheck },
      { id: "archived", label: "Archived", blurb: "Archived skills, tasks & agents", icon: Box },
      { id: "admin", label: "Admin", blurb: "Operator console (deployment admin)", icon: ShieldCheck },
      { id: "workspace-facts", label: "Workspace facts", blurb: SETTINGS_SECTION_LABELS["workspace-facts"].blurb, icon: ShieldCheck },
      { id: "remote", label: "Remote access", blurb: "Connected computers & daemon", icon: Laptop },
      { id: "models", label: "Models", blurb: SETTINGS_SECTION_LABELS.models.blurb, icon: Cpu },
      { id: "sandbox", label: "Sandbox", blurb: SETTINGS_SECTION_LABELS.sandbox.blurb, icon: Box },
      { id: "repositories", label: "Repositories", blurb: SETTINGS_SECTION_LABELS.repositories.blurb, icon: GitBranch },
      { id: "environments", label: "Environments", blurb: SETTINGS_SECTION_LABELS.environments.blurb, icon: Server },
      { id: "slack", label: "Slack", blurb: SETTINGS_SECTION_LABELS.slack.blurb, icon: Webhook },
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
  const currentActive = active ?? activeSection ?? "overview";
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
  providersBlocked?: boolean;
  className?: string;
}

const SETTINGS_PAGE_SECTION_IDS: readonly string[] = SETTINGS_PAGE_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));

/** Experimental flags now live in Deployment; the retired id keeps resolving for old deep links. */
const canonicalSection = (id: string): string => (id === "experimental" ? "deployment" : id);

/** Returns `id` when it names a known settings section, otherwise "account". */
export function normalizeSettingsSection(id: string | null | undefined): string {
  const section = id ? canonicalSection(id) : id;
  return section && SETTINGS_PAGE_SECTION_IDS.includes(section) ? section : "account";
}

function getSectionLabel(id: string): string {
  if (id === "overview") return "Overview";
  if (id === "team") return "Team";
  if (id === "remote") return "Remote access";
  if (id in SETTINGS_SECTION_LABELS) {
    return SETTINGS_SECTION_LABELS[id as SettingsSectionId].label;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Shown in place of personal or deployment settings while a team workspace (or blocked private data) is active. */
function PersonalWorkspaceNotice({
  message,
  onOpenPersonalWorkspace,
  className,
}: {
  message: string;
  onOpenPersonalWorkspace?: () => void;
  className: string;
}): JSX.Element {
  return (
    <section aria-label="Personal workspace setting" className={className}>
      <h2 className="text-base font-medium">Open this setting in your personal workspace</h2>
      <p className="mt-2 text-[#71717a] dark:text-zinc-400">{message}</p>
      {onOpenPersonalWorkspace ? <button
        type="button"
        onClick={onOpenPersonalWorkspace}
        className="mt-4 min-h-11 rounded-lg border border-[#e4e4e7] px-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] dark:border-zinc-800"
      >
        Switch to personal workspace
      </button> : null}
    </section>
  );
}

type OverviewAction = { label: string } & ({ run: () => void } | { href: string });

interface OverviewCategory {
  id: string;
  title: string;
  description: string;
  icon: SettingsNavGroup["items"][number]["icon"];
  actions: OverviewAction[];
  note?: string;
}

/**
 * Settings overview: one card per supported settings area. Every action reuses an
 * existing section id or app view, so the overview adds no data, endpoints or
 * state of its own. In a team workspace only the Team card applies.
 */
function SettingsOverview({
  guarded,
  providersBlocked,
  onSelectSection,
  onNavigate,
  onOpenPersonalWorkspace,
}: {
  guarded: boolean;
  providersBlocked: boolean;
  onSelectSection: (section: SettingsPageSectionId) => void;
  onNavigate?: (view: AppNavView) => void;
  onOpenPersonalWorkspace?: () => void;
}): JSX.Element {
  const section = (label: string, id: SettingsPageSectionId): OverviewAction => ({ label, run: () => onSelectSection(id) });
  const view = (label: string, target: AppNavView): OverviewAction[] =>
    onNavigate ? [{ label, run: () => onNavigate(target) }] : [];

  const categories: OverviewCategory[] = guarded
    ? [
        {
          id: "workspace",
          title: "Workspace",
          description: "Members, invitations and roles for the selected team.",
          icon: Building2,
          actions: [section("Team settings", "team")],
        },
      ]
    : [
        {
          id: "account",
          title: "Account",
          description: "Your identity, sign-in method and sign out.",
          icon: User,
          actions: [section("Manage account", "account")],
        },
        {
          id: "repositories",
          title: "Repositories",
          description: "Saved GitHub repositories that appear as picks in the task composer.",
          icon: GitBranch,
          actions: [section("Manage repositories", "repositories")],
        },
        {
          id: "providers-models",
          title: "Providers & models",
          description: "Your AI provider accounts, default provider and per-role model routing.",
          icon: Cpu,
          note: providersBlocked ? "Provider setup needs an explicit account grant for invited accounts." : undefined,
          actions: [
            ...(providersBlocked ? [] : [section("Review providers", "providers")]),
            section("Review model routing", "models"),
          ],
        },
        {
          id: "connected-apps",
          title: "Connected apps",
          description: "External apps you have authorized to connect to this deployment over MCP.",
          icon: Plug,
          actions: [section("Review connected apps", "connected-apps")],
        },
        ...(onNavigate ? [{
          id: "connections",
          title: "Connections",
          description: "GitHub repositories, app connectors, Slack and MCP servers.",
          icon: Webhook,
          actions: [
            ...view("Review connections", "integrations"),
            { label: "Open MCP servers", href: `${pathForView("integrations")}?tab=mcp` },
          ],
        }] : []),
        ...(onNavigate
          ? [
              {
                id: "employee-access",
                title: "Employee access",
                description: "Grant tools per employee. A connection never grants access by itself.",
                icon: ShieldCheck,
                actions: view("Manage employee access", "employee-tools"),
              },
            ]
          : []),
        {
          id: "workspace",
          title: "Workspace",
          description: "Manage workspace membership and sandbox configuration.",
          icon: Building2,
          actions: [section("Team", "team"), section("Sandbox", "sandbox")],
        },
        {
          id: "appearance-notifications",
          title: "Appearance & notifications",
          description: "Theme, and in-app alerts for mentions, thread replies and approvals.",
          icon: Palette,
          actions: [section("Appearance", "appearance"), section("Notifications", "notifications")],
        },
        ...(onNavigate
          ? [
              {
                id: "skills",
                title: "Templates & skills",
                description: "Reusable agent templates and saved skills available to employees.",
                icon: Sparkles,
                actions: [...view("Open agents", "custom-agents"), ...view("Open skills", "skills")],
              },
            ]
          : []),
      ];

  const controlChips: [SettingsPageSectionId, string][] = guarded ? [] : [
    ["appearance", "Appearance"], ["notifications", "Notifications"], ["api-keys", "API keys"], ["archived", "Archived"], ["environments", "Environments"],
    ["sandbox", "Sandbox"], ["slack", "Slack"], ["admin", "Admin"], ["deployment", "Deployment"],
  ];
  const actionClass = "inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--button)] px-3 text-xs font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--button-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-xl font-semibold text-[var(--fg)]">Settings overview</h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-[var(--muted-foreground-2)]">
          {guarded
            ? "Team settings apply to the selected workspace. Other settings belong to your personal workspace."
            : "Manage your account, connected tools and employee access from one place."}
        </p>
      </header>

      {guarded ? (
        <PersonalWorkspaceNotice
          message="Account, provider, repository and deployment settings apply to your account or this deployment, not to the selected team."
          onOpenPersonalWorkspace={onOpenPersonalWorkspace}
          className="max-w-xl text-sm text-[var(--fg)]"
        />
      ) : null}

      <section aria-label="Settings categories">
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,17.5rem),1fr))] gap-3.5 p-0">
          {categories.map((category) => {
            const Icon = category.icon;
            const headingId = `settings-overview-${category.id}`;
            return (
              <li key={category.id} className="min-w-0">
                <article
                  aria-labelledby={headingId}
                  className="flex h-full flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-5 shadow-[var(--sh-card)] transition-colors hover:border-[var(--border-3)]"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] text-[var(--fg)]"
                  >
                    <Icon className="size-[18px]" strokeWidth={1.7} aria-hidden="true" />
                  </span>
                  <h3 id={headingId} className="text-sm font-semibold text-[var(--fg)]">{category.title}</h3>
                  <p className="text-xs leading-relaxed text-[var(--muted-foreground-2)]">{category.description}</p>
                  {category.note ? (
                    <p className="text-xs leading-relaxed text-[var(--muted-foreground-1)]">{category.note}</p>
                  ) : null}
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {category.actions.map((action) => "href" in action
                      ? <a key={action.label} href={action.href} className={actionClass}>{action.label}<span aria-hidden="true">→</span></a>
                      : <button key={action.label} type="button" onClick={action.run} className={actionClass}>{action.label}<span aria-hidden="true">→</span></button>)}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </section>

      {controlChips.length > 0 ? (
        <section aria-labelledby="settings-overview-controls" className="flex flex-col gap-3">
          <h3 id="settings-overview-controls" className="text-sm font-semibold text-[var(--fg)]">Workspace controls</h3>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {controlChips.map(([id, label]) => (
              <li key={id}>
                <button type="button" onClick={() => onSelectSection(id)} className="inline-flex min-h-11 items-center rounded-full border border-[var(--border-1)] bg-[var(--button)] px-3.5 text-xs font-semibold text-[var(--fg)] hover:bg-[var(--button-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">{label}</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        role="note"
        aria-labelledby="settings-approval-boundary"
        className="flex gap-3 rounded-[var(--radius-card)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)] p-4 sm:p-5"
      >
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--warning-fg)]" strokeWidth={1.8} aria-hidden="true" />
        <div className="min-w-0">
          <h3 id="settings-approval-boundary" className="text-sm font-semibold text-[var(--fg)]">Approval boundary</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground-1)]">
            A connection does not grant any employee access by itself. Read grants allow only the scoped
            reads you select. Interactive tasks require approval of exact inputs; unattended automations
            follow their configured allowlists.
          </p>
        </div>
      </section>
    </div>
  );
}

/**
 * SettingsPage — Full page Settings main view:
 * Renders the selected section inside MainCard with breadcrumb "Settings > <Section>",
 * each section as a structured card of rows.
 */
export function SettingsPage({
  section,
  initialSection = "overview",
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
  providersBlocked = false,
  className = "",
}: SettingsPageProps): JSX.Element {
  const [internalSection, setInternalSection] = useState(initialSection);
  const activeSection = canonicalSection(section ?? internalSection);

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
            value={SETTINGS_PAGE_SECTION_IDS.includes(activeSection) ? activeSection : "overview"}
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
        {activeSection === "overview" ? (
          <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
            <SettingsOverview
              guarded={Boolean(onOpenPersonalWorkspace || personalDataBlocked)}
              providersBlocked={providersBlocked}
              onSelectSection={handleSectionChange}
              onNavigate={onNavigate}
              onOpenPersonalWorkspace={onOpenPersonalWorkspace}
            />
          </div>
        ) : (onOpenPersonalWorkspace || personalDataBlocked) && activeSection !== "team" ? (
          <PersonalWorkspaceNotice
            message={`${currentLabel} applies to your account or this deployment, not to the selected team.`}
            onOpenPersonalWorkspace={onOpenPersonalWorkspace}
            className="m-6 max-w-xl text-sm text-[#0a0a0a] dark:text-zinc-100"
          />
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
        ) : activeSection === "providers" && providersBlocked ? (
          <section aria-label="Personal provider setup unavailable" className="m-6 text-sm text-[var(--fg)]">
            <h2 className="text-base font-medium">Personal provider setup needs an explicit account grant</h2>
            <p className="mt-2">Connecting providers is unavailable for invited accounts until an owned provider and its billing permissions are verified.</p>
          </section>
        ) : activeSection === "remote" ? (
          <RemoteAccessView />
        ) : activeSection === "groups" ? (
          <div className="max-w-4xl mx-auto p-6 lg:p-8"><GroupsSettings workspaceId={workspaceId} /></div>
        ) : activeSection === "sharing" ? (
          <div className="max-w-4xl mx-auto p-6 lg:p-8"><SharingSettings workspaceId={workspaceId} /></div>
        ) : activeSection === "archived" ? (
          <div className="max-w-4xl mx-auto p-6 lg:p-8"><ArchivedSettings workspaceId={workspaceId} /></div>
        ) : activeSection === "admin" ? (
          <div className="max-w-4xl mx-auto p-6 lg:p-8"><AdminSettings onOpenTeam={() => handleSectionChange("team")} /></div>
        ) : (
          <div className="max-w-4xl mx-auto p-6 lg:p-8 flex flex-col gap-6">
            <SettingsSectionBody
              section={activeSection as SettingsSectionId}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
              onSelectSection={handleSectionChange}
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
