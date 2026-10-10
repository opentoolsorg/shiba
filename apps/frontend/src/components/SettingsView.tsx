/**
 * SettingsView — the settings section bodies mounted by SettingsModal (the
 * Kosuke-style popup) and any full-page embed. Every section mounts the REAL
 * surface (MemoryTab, /api/setup/status, /api/agents, /api/whoami,
 * /api/auth/*) rather than duplicating internals; sections with no real data
 * source are omitted, not stubbed.
 */
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { version as dashboardVersion } from "../../package.json";
import { authClient } from "../auth-client";
import {
  type AgentCliEntry,
  type RoleModelWire,
  type SetupStatus,
  useAgentsDirectory,
  useSetupStatus,
  useWhoami,
} from "../live-status";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { MemoryTab } from "./MemoryTab";
import { ConnectionsCard, PurposeRoutingCard } from "./ModelRoutingSection";
import { Card } from "./settings-ui";
import {
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  type SubscriptionId,
  type SubscriptionStatus,
  subscriptionChip,
} from "./SubscriptionConnect";
import { ToneChip } from "./ToneChip";
import { useTheme } from "./ThemeProvider";
import { useSavedRepos, saveRepo, removeRepo } from "../saved";

export type SettingsSectionId =
  | "account"
  | "appearance"
  | "repositories"
  | "providers"
  | "models"
  | "environments"
  | "memory"
  | "guidance"
  | "experimental"
  | "deployment";

/** Single source for section labels — the modal nav groups render from this. */
export const SETTINGS_SECTION_LABELS: Record<
  SettingsSectionId,
  { label: string; blurb: string }
> = {
  account: { label: "Account", blurb: "Identity, auth lane & sign out" },
  appearance: { label: "Appearance", blurb: "Theme" },
  repositories: { label: "Repositories", blurb: "Saved GitHub targets" },
  providers: { label: "AI Providers", blurb: "Your AI agents" },
  models: { label: "Models", blurb: "Per-role agent routing" },
  environments: {
    label: "Environments",
    blurb: "Deployment configuration the Worker proves",
  },
  memory: { label: "Memory", blurb: "Vectorize long-term semantic memory" },
  guidance: { label: "API keys & MCP", blurb: "MCP principals & capability scopes" },
  experimental: { label: "Experimental", blurb: "Opt-in feature flags (wrangler vars)" },
  deployment: { label: "Deployment", blurb: "Serving host, models & harness" },
};

function SectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-[#222320]">{title}</h3>
        <p className="mt-0.5 text-xs text-[#6a6f63]">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** One row of the environments checklist: a label, a proven boolean, and a detail line. */
function ChecklistRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-none border text-[10px] font-bold ${
          ok
            ? "border-[#15803d]/40 bg-[#15803d]/10 text-[#15803d]"
            : "border-[#d3d2c8] bg-[#e0ded5]/60 text-[#6a6f63]"
        }`}
      >
        {ok ? "✓" : "·"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-[#222320]">{label}</div>
        <div className="font-mono text-[11px] text-[#6a6f63]">{detail}</div>
      </div>
    </div>
  );
}

function ProviderLaneRow({
  id,
  agents,
}: {
  id: SubscriptionId;
  agents: AgentCliEntry[];
}): JSX.Element {
  const spec = SUBSCRIPTION_AUTH[id];
  const credential = agents.find((entry) => entry.id === id)?.credential ?? spec.credential;
  const [status, setStatus] = useState<SubscriptionStatus>({ kind: "loading" });
  return (
    <div className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#222320]">{spec.label}</div>
          <div className="text-[11px] text-[#6a6f63]">{spec.blurb}</div>
        </div>
        {subscriptionChip(status)}
      </div>
      <SubscriptionConnect spec={spec} credential={credential} onStatus={setStatus} />
    </div>
  );
}

const ROLE_SOURCE_LABEL: Record<RoleModelWire["source"], string> = {
  "role-map": "ROLE_MODEL_MAP",
  "role-env": "ROLE_MODEL__",
  default: "Deployment default",
};

/**
 * One role row of the Models section: a read-only harness picker (the live
 * /api/agents catalog) plus the model the backend resolved for that role.
 * Values are env-driven — the row shows where to set them, never a form.
 */
function RoleModelRow({
  row,
  agents,
}: {
  row: RoleModelWire;
  agents: AgentCliEntry[];
}): JSX.Element {
  const roleVar = `ROLE_MODEL__${row.role.toUpperCase()}`;
  const options =
    row.harness === "" || agents.some((a) => a.id === row.harness)
      ? agents
      : [...agents, { id: row.harness, label: row.harness } as AgentCliEntry];
  return (
    <div className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-[#222320]">{row.role}</div>
        <ToneChip
          tone={row.error ? "danger" : row.source === "default" ? "neutral" : "navy"}
          label={
            row.error
              ? "Pin error"
              : row.source === "role-env"
                ? roleVar
                : ROLE_SOURCE_LABEL[row.source]
          }
        />
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <select
          disabled
          value={row.harness}
          aria-label={`${row.role} harness`}
          className="bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-medium disabled:opacity-80 disabled:cursor-not-allowed sm:w-56"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          readOnly
          value={row.model}
          aria-label={`${row.role} model`}
          spellCheck={false}
          className="flex-1 bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-mono read-only:opacity-80"
        />
      </div>
      {row.error ? <div className="mt-1.5 text-[11px] text-[#b91c1c]">{row.error}</div> : null}
      <div className="mt-1.5 font-mono text-[11px] text-[#6a6f63]">
        set via ROLE_MODEL_MAP["{row.role}"] or {roleVar}
      </div>
    </div>
  );
}

function ModelsSection({
  status,
  agents,
}: {
  status: SetupStatus | undefined;
  agents: AgentCliEntry[];
}): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          Reading /api/setup/status…
        </div>
      </Card>
    );
  }
  const rows = status.models.roles ?? [];
  return (
    <>
      <Card>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
            This deployment doesn't report per-role routing — update the backend.
          </div>
        ) : (
          rows.map((row) => <RoleModelRow key={row.role} row={row} agents={agents} />)
        )}
      </Card>
      <Card>
        <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
          How to pin a role (wrangler vars / secrets at deploy time)
        </div>
        <div className="px-4 py-3 flex flex-col gap-2">
          <div className="font-mono text-[11px] leading-relaxed text-[#222320] break-all">
            ROLE_MODEL_MAP={'{"fixer":{"harness":"opencode","model":"opencode-go/deepseek-v3.2"}}'}
          </div>
          <div className="font-mono text-[11px] leading-relaxed text-[#222320] break-all">
            ROLE_MODEL__REVIEWER="claude-subscription/anthropic-subscription/claude-sonnet-4-6"
          </div>
          <div className="text-xs text-[#6a6f63]">
            One JSON map, or a per-role {"<harness>/<provider>/<model>"} var (model optional — the
            harness's own *_MODEL var, then its catalog default, fills it in). An unpinned role
            resolves to the deployment default chain (AGENT_HARNESS, then opencode).
          </div>
        </div>
      </Card>
      <PurposeRoutingCard />
      <ConnectionsCard />
    </>
  );
}

function EnvironmentsSection({ status }: { status: SetupStatus | undefined }): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          Reading /api/setup/status…
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <ChecklistRow
        label="Slack signing secret"
        ok={status.slack.signingSecret}
        detail="SLACK_SIGNING_SECRET — verifies Slack callbacks"
      />
      <ChecklistRow
        label="Slack bot token"
        ok={status.slack.botToken}
        detail="SLACK_BOT_TOKEN — posts approval cards"
      />
      <ChecklistRow
        label="Slack approvers"
        ok={status.slack.approvers > 0}
        detail={`SLACK_APPROVERS — ${status.slack.approvers} configured`}
      />
      <ChecklistRow
        label="Slack channel→repo map"
        ok={status.slack.channelRepos}
        detail="SLACK_CHANNEL_REPOS — repo for bare mentions"
      />
      <ChecklistRow
        label="GitHub token"
        ok={status.github.token}
        detail="GITHUB_TOKEN — opens pull requests"
      />
      <ChecklistRow
        label="GitHub webhook secret"
        ok={status.github.webhookSecret}
        detail="GITHUB_WEBHOOK_SECRET — verifies deliveries"
      />
      <ChecklistRow
        label="AI Gateway token"
        ok={status.gateway.token}
        detail="AI_GATEWAY_TOKEN — BYOK provider egress"
      />
      <ChecklistRow
        label="AI Gateway reachable"
        ok={status.gateway.reachable === "yes"}
        detail={`gateway "${status.gateway.id}" — ${status.gateway.reachable}`}
      />
      <ChecklistRow
        label="Cloudflare Access required"
        ok={status.access.required}
        detail="REQUIRE_ACCESS / ACCESS_AUD — identity on every path"
      />
      <ChecklistRow
        label="Automations enabled"
        ok={status.automations.enabled}
        detail="AUTOMATIONS_ENABLED kill switch"
      />
      <ChecklistRow
        label="TypeSafe key"
        ok={status.automations.typeSafe}
        detail="TYPESAFE_API_KEY — System One judgments"
      />
    </Card>
  );
}

/** Static copy of the opt-in flags from wrangler.jsonc's vars comment block + env.ts. */
const EXPERIMENTAL_FLAGS: { flag: string; effect: string; related: string }[] = [
  {
    flag: "SHIBA_CLAUDE_SUBSCRIPTION=1",
    effect: "Registers the claude-subscription harness (T48).",
    related: "CLAUDE_SUBSCRIPTION_MODEL · CLAUDE_SUBSCRIPTION_TOKEN[_<ACCOUNT>] secret",
  },
  {
    flag: "SHIBA_CODEX_SUBSCRIPTION=1",
    effect: "Registers the codex-subscription harness (T49).",
    related: "CODEX_SUBSCRIPTION_MODEL · CODEX_SUBSCRIPTION_AUTH_JSON[_<ACCOUNT>] secret",
  },
  {
    flag: "SHIBA_ANTIGRAVITY_SUBSCRIPTION=1",
    effect:
      "Registers antigravity-subscription + /api/antigravity/callback (T50 pasted-redirect OAuth).",
    related:
      "ANTIGRAVITY_SUBSCRIPTION_MODEL — no secret var (tokens live in the container profile)",
  },
  {
    flag: "SHIBA_LOCAL_RUNTIME=1",
    effect: 'Admits runtime:"local" at intake and opens the /api/local daemon surface (T51).',
    related: "LOCAL_ADAPTER_TOKEN secret — unset = the surface refuses every request",
  },
];

const KILL_SWITCHES: { flag: string; effect: string }[] = [
  { flag: "AUTOMATIONS_ENABLED", effect: '"false"/"0"/"off" stops every automation firing.' },
  {
    flag: "MEMORY_ENABLED",
    effect: '"false"/"0"/"off" disables run-end distillation into Memory — never the run.',
  },
];

/** Row used by the Account section: a label, a live value, and an optional chip. */
function AccountRow({
  label,
  value,
  chip,
}: {
  label: string;
  value: string;
  chip?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs font-medium text-[#222320]">{label}</div>
        <div className="font-mono text-[11px] text-[#6a6f63] truncate">{value}</div>
      </div>
      {chip}
    </div>
  );
}

const AUTH_LANE_LABEL: Record<string, string> = {
  "better-auth": "Built-in dashboard login",
  access: "Cloudflare Access",
  none: "Open (no auth)",
};

/** Account — the identity the Worker proves via /api/whoami plus sign-out. */
function AccountSection({
  status,
  onSignOut,
}: {
  status: SetupStatus | undefined;
  onSignOut?: () => void;
}): JSX.Element {
  const whoami = useWhoami();
  const [signingOut, setSigningOut] = useState(false);
  const identity = whoami.state.kind === "data" ? whoami.state.data : undefined;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";

  const signOut = async () => {
    setSigningOut(true);
    try {
      if (onSignOut) {
        onSignOut();
      } else {
        await authClient.signOut().catch(() => {});
        window.location.reload();
      }
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Card>
      {whoami.state.kind === "error" ? (
        <div className="px-4 py-5">
          <LoadErrorState message={whoami.state.message} onRetry={whoami.reload} />
        </div>
      ) : !identity ? (
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          Reading /api/whoami…
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-[#e0ded5] px-4 py-3.5">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-none border border-[#0000a8]/40 bg-[#0000a8]/10 text-sm font-bold uppercase text-[#1c1cc8]"
            >
              {identity.agent.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[#222320]">
                {identity.agent}
              </div>
              <div className="font-mono text-[11px] text-[#6a6f63]">
                {AUTH_LANE_LABEL[identity.auth ?? ""] ?? identity.auth ?? "Unknown lane"}
              </div>
            </div>
          </div>
          <AccountRow label="Serving host" value={hostname || "unknown"} />
          <AccountRow
            label="GitHub"
            value="GITHUB_TOKEN — opens pull requests"
            chip={
              status ? (
                <ToneChip
                  tone={status.github.token ? "ok" : "neutral"}
                  label={status.github.token ? "Configured" : "Not configured"}
                />
              ) : undefined
            }
          />
          {identity.auth === "better-auth" ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-xs text-[#6a6f63]">
                Signs out of this dashboard session only.
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="shrink-0 rounded-none border border-[#fb2c36]/50 bg-[#fb2c36]/10 px-3 py-1.5 text-[11px] font-semibold text-[#fb2c36] transition-colors hover:bg-[#fb2c36]/20 disabled:opacity-60"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

const THEME_OPTIONS: { id: "dark" | "light" | "system"; label: string; hint: string; glyph: string }[] =
  [
    { id: "dark", label: "Dark", hint: "Paper-on-ink, low glare", glyph: "◐" },
    { id: "light", label: "Light", hint: "Bright paper surface", glyph: "☀" },
    { id: "system", label: "System", hint: "Follows OS appearance", glyph: "⌘" },
  ];

/** Appearance — the real next-themes picker the nav rail toggle shares. */
function AppearanceSection(): JSX.Element {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <Card>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-2 px-4 py-4 lg:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const active = (theme ?? "system") === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setTheme(option.id)}
              role="radio"
              aria-checked={active}
              className={
                "flex flex-col items-start gap-1 rounded-none border px-3 py-3 text-left transition-colors " +
                (active
                  ? "border-[#0000a8]/50 bg-[#0000a8]/10 shadow-[2px_2px_0_var(--paper-shadow)]"
                  : "border-[#e0ded5] bg-[#f6f4ed] hover:border-[#d3d2c8] hover:bg-[#f1efe6]")
              }
            >
              <span className="flex w-full items-center justify-between">
                <span aria-hidden="true" className="text-base text-[#222320]">
                  {option.glyph}
                </span>
                {active ? (
                  <span aria-hidden="true" className="text-xs font-bold text-[#1c1cc8]">
                    ✓
                  </span>
                ) : null}
              </span>
              <span className="text-xs font-semibold text-[#222320]">{option.label}</span>
              <span className="text-[10px] leading-snug text-[#6a6f63]">{option.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="border-t border-[#e0ded5] px-4 py-2.5 font-mono text-[11px] text-[#6a6f63]">
        Active: {theme ?? "system"}
        {theme === "system" && resolvedTheme ? " (resolved: " + resolvedTheme + ")" : ""} —
        keyboard: press D anywhere
      </div>
    </Card>
  );
}

/**
 * The real settings content for one section — shared by the SettingsModal
 * popup and any full-page embed. Owns its own data hooks, so each shell
 * gets a fresh read of /api/setup/status, /api/agents, and /api/whoami.
 */
export function SettingsSectionBody({
  section,
  onNavigate,
  onSignOut,
}: {
  section: SettingsSectionId;
  onNavigate?: (view: AppNavView) => void;
  onSignOut?: () => void;
}): JSX.Element {
  const directory = useAgentsDirectory();
  const setup = useSetupStatus();

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const agents = directory.state.kind === "data" ? directory.state.data.agents : [];
  const principals = directory.state.kind === "data" ? directory.state.data.principals : undefined;
  const secretCredentials = useMemo(
    () =>
      (directory.state.kind === "data" ? directory.state.data.agents : []).filter(
        (entry) => entry.credential.kind !== "ai-gateway-byok",
      ),
    [directory.state],
  );

  const hostname = typeof window !== "undefined" ? window.location.hostname : "";

  if (section === "account") {
    return (
      <SectionShell
        title="Account"
        description="Who you are to this deployment — the identity GET /api/whoami proves, plus the auth lane and sign-out."
      >
        <AccountSection status={status} onSignOut={onSignOut} />
      </SectionShell>
    );
  }

  if (section === "appearance") {
    return (
      <SectionShell
        title="Appearance"
        description="Dashboard theme — stored per browser, shared with the nav rail toggle and the D shortcut."
      >
        <AppearanceSection />
      </SectionShell>
    );
  }

  if (section === "repositories") {
    return (
      <SectionShell
        title="Repositories"
        description="GitHub repos you've saved — they show up as picks in the task composer and fill in automatically when you reuse one."
      >
        <RepositoriesSection />
      </SectionShell>
    );
  }

  if (section === "providers") {
    return (
      <SectionShell
        title="AI Providers"
        description="Your AI agents. Connect a provider to let it run tasks for you — disconnect any time."
      >
        <Card>
          {(Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[]).map((id) => (
            <ProviderLaneRow key={id} id={id} agents={agents} />
          ))}
        </Card>
        <Card>
          <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
            Other credentials
          </div>
          {secretCredentials.length === 0 ? (
            <div className="px-4 py-5 text-center text-xs text-[#6a6f63]">
              {directory.state.kind === "loading"
                ? "Loading catalog…"
                : "No secret-backed credentials in this deployment's catalog."}
            </div>
          ) : (
            secretCredentials.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[#222320]">{entry.label}</div>
                  <div className="font-mono text-[11px] text-[#6a6f63]">
                    {entry.credential.label}
                  </div>
                  {entry.credential.configured === false && entry.credential.setupHint ? (
                    <div className="mt-0.5 font-mono text-[11px] text-[#b45309]">
                      {entry.credential.setupHint}
                    </div>
                  ) : null}
                </div>
                <ToneChip
                  tone={
                    entry.credential.configured === true
                      ? "ok"
                      : entry.credential.configured === false
                        ? "danger"
                        : "neutral"
                  }
                  label={
                    entry.credential.configured === true
                      ? "Configured"
                      : entry.credential.configured === false
                        ? "Not set up"
                        : "Not introspectable"
                  }
                />
              </div>
            ))
          )}
        </Card>
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate("agents")}
            className="self-start text-xs font-semibold text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
          >
            Manage agents & MCP →
          </button>
        ) : null}
      </SectionShell>
    );
  }

  if (section === "models") {
    return (
      <SectionShell
        title="Models"
        description="Which agent CLI + model each delegation role runs — resolved live from ROLE_MODEL_MAP / ROLE_MODEL__* env vars. Read-only: the Worker reports env state; set vars at deploy time."
      >
        {setup.state.kind === "error" ? (
          <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
        ) : (
          <ModelsSection status={status} agents={agents} />
        )}
      </SectionShell>
    );
  }

  if (section === "environments") {
    return (
      <SectionShell
        title="Environments"
        description="Configuration the deployment itself proves — every row is a boolean from GET /api/setup/status."
      >
        {setup.state.kind === "error" ? (
          <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
        ) : (
          <EnvironmentsSection status={status} />
        )}
      </SectionShell>
    );
  }

  if (section === "memory") {
    return (
      <SectionShell
        title="Memory"
        description="Long-term semantic memory — the same MemoryTab mounted in the Memory view."
      >
        <MemoryTab />
      </SectionShell>
    );
  }

  if (section === "guidance") {
    return (
      <SectionShell
        title="API keys & MCP"
        description="Registered MCP-token principals and their capability scopes (read-only — managed in Agents & MCP)."
      >
        <Card>
          {principals === undefined ? (
            <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
              {directory.state.kind === "error"
                ? "Could not load /api/agents."
                : "Loading principals…"}
            </div>
          ) : principals.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
              No MCP-token principals registered.
            </div>
          ) : (
            principals.map((principal) => (
              <div
                key={principal.principal}
                className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[#222320]">{principal.principal}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {principal.scopes.map((scope) => (
                      <span
                        key={scope}
                        className="rounded-none border border-[#e0ded5] bg-[#f6f4ed] px-1.5 py-px font-mono text-[10px] text-[#6a6f63]"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                </div>
                <ToneChip
                  tone={principal.live ? "ok" : "neutral"}
                  label={principal.live ? "Live" : "Revoked"}
                />
              </div>
            ))
          )}
        </Card>
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate("agents")}
            className="self-start text-xs font-semibold text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
          >
            Open Agents & MCP →
          </button>
        ) : null}
      </SectionShell>
    );
  }

  if (section === "experimental") {
    return (
      <SectionShell
        title="Experimental"
        description="Opt-in feature flags. These are set via wrangler vars/secrets at deploy time — this list mirrors wrangler.jsonc's vars comment block; it cannot read live values."
      >
        <Card>
          {EXPERIMENTAL_FLAGS.map((flag) => (
            <div key={flag.flag} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
              <div className="font-mono text-xs font-semibold text-[#1c1cc8]">{flag.flag}</div>
              <div className="mt-0.5 text-xs text-[#222320]">{flag.effect}</div>
              <div className="mt-0.5 font-mono text-[11px] text-[#6a6f63]">{flag.related}</div>
            </div>
          ))}
        </Card>
        <Card>
          <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
            Kill switches (env.ts)
          </div>
          {KILL_SWITCHES.map((flag) => (
            <div key={flag.flag} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
              <div className="font-mono text-xs font-semibold text-[#1c1cc8]">{flag.flag}</div>
              <div className="mt-0.5 text-xs text-[#222320]">{flag.effect}</div>
            </div>
          ))}
        </Card>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Deployment"
      description="What this dashboard is served by — the Worker serving this page is the deployment."
    >
      <Card>
        <div className="border-b border-[#e0ded5] px-4 py-2.5">
          <div className="text-xs font-medium text-[#222320]">Serving host</div>
          <div className="font-mono text-[11px] text-[#6a6f63]">{hostname || "unknown"}</div>
        </div>
        <div className="border-b border-[#e0ded5] px-4 py-2.5">
          <div className="text-xs font-medium text-[#222320]">Dashboard package</div>
          <div className="font-mono text-[11px] text-[#6a6f63]">
            @shiba/frontend@{dashboardVersion}
          </div>
        </div>
        {status ? (
          <>
            <div className="border-b border-[#e0ded5] px-4 py-2.5">
              <div className="text-xs font-medium text-[#222320]">Orchestrator model</div>
              <div className="font-mono text-[11px] text-[#6a6f63]">
                {status.models.orchestrator}
              </div>
            </div>
            <div className="border-b border-[#e0ded5] px-4 py-2.5">
              <div className="text-xs font-medium text-[#222320]">Coding model</div>
              <div className="font-mono text-[11px] text-[#6a6f63]">{status.models.coding}</div>
            </div>
            <div className="border-b border-[#e0ded5] px-4 py-2.5">
              <div className="text-xs font-medium text-[#222320]">Default harness</div>
              <div className="font-mono text-[11px] text-[#6a6f63]">{status.models.harness}</div>
            </div>
            <div className="px-4 py-2.5">
              <div className="text-xs font-medium text-[#222320]">AI Gateway</div>
              <div className="font-mono text-[11px] text-[#6a6f63]">
                {status.gateway.id} · {status.gateway.reachable}
              </div>
            </div>
          </>
        ) : (
          <div className="px-4 py-2.5 text-xs text-[#6a6f63]">
            {setup.state.kind === "error"
              ? "Model details unavailable — /api/setup/status failed."
              : "Reading /api/setup/status…"}
          </div>
        )}
      </Card>
    </SectionShell>
  );
}


function RepositoriesSection(): JSX.Element {
  const repos = useSavedRepos();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const clean = draft.trim();
    if (!clean.startsWith("https://github.com/")) {
      setError("Repository URL must look like https://github.com/owner/repo.");
      return;
    }
    saveRepo(clean);
    setDraft("");
    setError(null);
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-[#e0ded5] flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="New repository URL"
            className="flex-1 bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60 transition-colors"
          />
          <button
            type="button"
            onClick={add}
            className="text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/15 text-[#1c1cc8] font-medium py-1.5 px-3 rounded-none transition-colors shrink-0"
          >
            Save repo
          </button>
        </div>
        {error ? <span className="text-[11px] text-[#fb2c36]">{error}</span> : null}
      </div>
      {repos.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          None saved yet — repos you run tasks against are saved automatically too.
        </div>
      ) : (
        repos.map((repo) => (
          <div key={repo} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0 flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-[#222320] truncate">{repo}</span>
            <button
              type="button"
              onClick={() => removeRepo(repo)}
              aria-label={`Remove ${repo}`}
              className="shrink-0 text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#e0ded5] hover:border-[#fb2c36]/50 text-[#6a6f63] hover:text-[#fb2c36] font-medium py-1 px-2.5 rounded-none transition-colors"
            >
              Remove
            </button>
          </div>
        ))
      )}
    </Card>
  );
}
