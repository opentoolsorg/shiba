/**
 * Settings section bodies mounted by SettingsModal (the Kosuke-style popup).
 * Sections mount only the live data they need from /api/setup/status,
 * /api/agents, and /api/whoami, /api/auth/*) rather than duplicating
 * internals; sections with no real data source are omitted, not stubbed.
 */
import { type JSX, type ReactNode, useCallback, useEffect, useState } from "react";
import { version as dashboardVersion } from "../../package.json";
import { authClient } from "../auth-client";
import { type RoleModelWire, type SetupStatus, useSetupStatus, useWhoami } from "../live-status";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { SkeletonLines, StatusNotice } from "./surface";
import { ChatGptSubscriptionCard } from "./ChatGptSubscriptionCard";
import { PurposeRoutingCard, RolePinsCard } from "./ModelRoutingSection";
import { Card } from "./settings-ui";
import { ToneChip } from "./ToneChip";
import { useTheme } from "./ThemeProvider";
import { useSavedRepos, saveRepo, removeRepo } from "../saved";

export type SettingsSectionId =
  | "account"
  | "api-keys"
  | "appearance"
  | "repositories"
  | "automations"
  | "mailbox"
  | "models"
  | "sandbox"
  | "environments"
  | "experimental"
  | "deployment";

/** Single source for section labels — the modal nav groups render from this. */
export const SETTINGS_SECTION_LABELS: Record<SettingsSectionId, { label: string; blurb: string }> =
  {
    account: { label: "Account", blurb: "Identity, auth lane & sign out" },
    "api-keys": { label: "API keys", blurb: "Org-scoped /api/v1 bearer keys" },
    appearance: { label: "Appearance", blurb: "Theme" },
    repositories: { label: "Repositories", blurb: "Saved GitHub targets" },
    automations: { label: "Automations", blurb: "Kill switch & TypeSafe key" },
    mailbox: { label: "Mailbox", blurb: "Agent mailbox & email sending" },
    models: { label: "Models", blurb: "Per-role agent routing" },
    sandbox: { label: "Sandbox", blurb: "Org sandbox provider & capabilities" },
    environments: {
      label: "Environments",
      blurb: "Deployment configuration the Worker proves",
    },
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
        <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
        <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Deep-link out of settings into a first-class app view. */
function ViewLink({
  view,
  label,
  onNavigate,
}: {
  view: AppNavView;
  label: string;
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element | null {
  if (!onNavigate) return null;
  return (
    <button
      type="button"
      onClick={() => onNavigate(view)}
      className="self-start text-xs font-semibold text-[var(--primary)] transition-colors hover:text-[var(--primary)]"
    >
      {label} →
    </button>
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
    <div className="flex items-start gap-2.5 border-b border-[var(--border-1)] px-4 py-2.5 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-button)] border text-[10px] font-bold ${
          ok
            ? "border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]"
            : "border-[var(--border-2)] bg-[var(--secondary)] text-[var(--muted-foreground-2)]"
        }`}
      >
        {ok ? "✓" : "·"}
      </span>
      <span className="sr-only">{ok ? "Configured" : "Not configured"}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-[var(--fg)]">{label}</div>
        <div className="font-mono text-[11px] text-[var(--muted-foreground-2)]">{detail}</div>
      </div>
    </div>
  );
}

const ROLE_SOURCE_LABEL: Record<RoleModelWire["source"], string> = {
  dashboard: "Dashboard pin",
  "role-map": "ROLE_MODEL_MAP",
  "role-env": "ROLE_MODEL__",
  "connection-default": "Single connection",
  default: "Deployment default",
};

/**
 * One role row of the Models section. Values are deployment-resolved and
 * displayed as text so read-only state does not look editable.
 */
function RoleModelRow({ row }: { row: RoleModelWire }): JSX.Element {
  const roleVar = `ROLE_MODEL__${row.role.toUpperCase()}`;
  return (
    <div className="border-b border-[var(--border-1)] px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-[var(--fg)]">{row.role}</div>
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
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="border border-[var(--border-1)] bg-[var(--panel)] px-2.5 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">Harness</div>
          <div className="font-mono text-xs text-[var(--fg)]">{row.harness || "Not resolved"}</div>
        </div>
        <div className="border border-[var(--border-1)] bg-[var(--panel)] px-2.5 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">Model</div>
          <div className="break-all font-mono text-xs text-[var(--fg)]">{row.model || "Default"}</div>
        </div>
      </div>
      {row.error ? <div className="mt-1.5 text-[11px] text-[var(--destructive)]">{row.error}</div> : null}
      <div className="mt-1.5 font-mono text-[11px] text-[var(--muted-foreground-2)]">
        set via ROLE_MODEL_MAP["{row.role}"] or {roleVar}
      </div>
    </div>
  );
}

function ModelsSection({ status }: { status: SetupStatus | undefined }): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div role="status" className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
          Reading /api/setup/status…
        </div>
      </Card>
    );
  }
  const rows = status.models.roles ?? [];
  return (
    <>
      <RolePinsCard />
      <Card>
        <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          Deploy-time pins (wrangler vars — overridden by dashboard pins above)
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
            This deployment doesn't report per-role routing — update the backend.
          </div>
        ) : (
          rows.map((row) => <RoleModelRow key={row.role} row={row} />)
        )}
      </Card>
      <ChatGptSubscriptionCard />
      <PurposeRoutingCard />
    </>
  );
}

function EnvironmentsSection({ status }: { status: SetupStatus | undefined }): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div role="status" className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
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
  {
    flag: "MEMORY_ENABLED",
    effect: '"false"/"0"/"off" disables run-end distillation into Memory — never the run.',
  },
];

const AUTH_LANE_LABEL: Record<string, string> = {
  "better-auth": "Built-in dashboard login",
  access: "Cloudflare Access",
  none: "Open (no auth)",
};

/** Account — the identity the Worker proves via /api/whoami plus sign-out. */
function AccountSection({ onSignOut }: { onSignOut?: () => Promise<void> }): JSX.Element {
  const whoami = useWhoami();
  const [signingOut, setSigningOut] = useState(false);
  const identity = whoami.state.kind === "data" ? whoami.state.data : undefined;

  const signOut = async () => {
    setSigningOut(true);
    try {
      if (onSignOut) {
        await onSignOut();
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
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Reading /api/whoami…</div>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3.5">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--primary)]/40 bg-[var(--primary-soft)] text-sm font-bold uppercase text-[var(--primary)]"
            >
              {identity.agent.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[var(--fg)]">
                {identity.agent}
              </div>
              <div className="font-mono text-[11px] text-[var(--muted-foreground-2)]">
                {AUTH_LANE_LABEL[identity.auth ?? ""] ?? identity.auth ?? "Unknown lane"}
              </div>
            </div>
          </div>
          {identity.auth === "better-auth" ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-xs text-[var(--muted-foreground-2)]">
                Signs out of this dashboard session only.
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="shrink-0 rounded-[var(--radius-button)] border border-[var(--destructive)]/50 bg-[var(--destructive-soft)] px-3 py-1.5 text-[11px] font-semibold text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/20 disabled:opacity-60"
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

const THEME_OPTIONS: {
  id: "dark" | "light" | "system";
  label: string;
  hint: string;
  glyph: string;
}[] = [
  { id: "dark", label: "Dark", hint: "Paper-on-ink, low glare", glyph: "◐" },
  { id: "light", label: "Light", hint: "Bright paper surface", glyph: "☀" },
  { id: "system", label: "System", hint: "Follows OS appearance", glyph: "⌘" },
];

/** Appearance — the real next-themes picker the nav rail toggle shares. */
function AppearanceSection(): JSX.Element {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <Card>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-1 gap-2 px-4 py-4 lg:grid-cols-3"
      >
        {THEME_OPTIONS.map((option) => {
          const active = (theme ?? "system") === option.id;
          return (
            <label
              key={option.id}
              data-active={active || undefined}
              className={
                "flex cursor-pointer flex-col items-start gap-1 rounded-[var(--radius-button)] border px-3 py-3 text-left transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-[var(--primary)] " +
                (active
                  ? "border-[var(--primary)]/50 bg-[var(--primary-soft)] shadow-[var(--sh-card)]"
                  : "border-[var(--border-1)] bg-[var(--bg)] hover:border-[var(--border-2)] hover:bg-[var(--panel)]")
              }
            >
              <input
                type="radio"
                name="dashboard-theme"
                value={option.id}
                checked={active}
                onChange={() => setTheme(option.id)}
                className="sr-only"
              />
              <span className="flex w-full items-center justify-between">
                <span aria-hidden="true" className="text-base text-[var(--fg)]">
                  {option.glyph}
                </span>
                {active ? (
                  <span aria-hidden="true" className="text-xs font-bold text-[var(--primary)]">
                    ✓
                  </span>
                ) : null}
              </span>
              <span className="text-xs font-semibold text-[var(--fg)]">{option.label}</span>
              <span className="text-[10px] leading-snug text-[var(--muted-foreground-2)]">{option.hint}</span>
            </label>
          );
        })}
      </div>
      <div className="border-t border-[var(--border-1)] px-4 py-2.5 font-mono text-[11px] text-[var(--muted-foreground-2)]">
        Active: {theme ?? "system"}
        {theme === "system" && resolvedTheme ? ` (resolved: ${resolvedTheme})` : ""} — keyboard:
        press D anywhere
      </div>
    </Card>
  );
}

interface SandboxProviderRow {
  id: string;
  label: string;
  configured: boolean;
  matrix: {
    exec: boolean;
    files: boolean;
    portsPreview: boolean;
    snapshots: boolean;
    volumes: boolean;
    edgeEgress: boolean;
  };
  detail?: string;
}

function SandboxOrgSettingsSection({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [effectiveSource, setEffectiveSource] = useState("");
  const [providers, setProviders] = useState<SandboxProviderRow[]>([]);
  const [computesdkBackend, setComputesdkBackend] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/org/sandbox")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Sandbox settings unavailable (${r.status}).`);
        return (await r.json()) as {
          settings?: { providerId?: string; computesdkBackend?: string } | null;
          effective?: { source?: string; providerId?: string };
          providers?: SandboxProviderRow[];
        };
      })
      .then((body) => {
        const saved = body.settings?.providerId ?? body.effective?.providerId ?? "cloudflare";
        setProviderId(saved);
        setComputesdkBackend(body.settings?.computesdkBackend ?? "");
        setEffectiveSource(body.effective?.source ?? "");
        setProviders(body.providers ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not load sandbox settings.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/org/sandbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          ...(providerId === "computesdk" && computesdkBackend.trim()
            ? { computesdkBackend: computesdkBackend.trim() }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice({ tone: "err", text: body.error ?? `Save failed (${response.status}).` });
      } else {
        setNotice({ tone: "ok", text: "Sandbox provider saved for this org." });
        reload();
      }
    } catch {
      setNotice({ tone: "err", text: "Save failed: backend unreachable." });
    } finally {
      setSaving(false);
    }
  };

  const matrixKeys = [
    ["exec", "Exec"],
    ["files", "Files"],
    ["portsPreview", "Ports"],
    ["snapshots", "Snapshots"],
    ["volumes", "Volumes"],
    ["edgeEgress", "Egress"],
  ] as const;

  return (
    <SectionShell
      title="Sandbox provider"
      description="Org-default sandbox backend (task → bot → org → deployment). Capability matrix is computed from each registered provider — including ComputeSDK and custom adapters."
    >
      {loading ? (
        <div role="status" aria-busy="true" aria-label="Loading sandbox settings">
          <SkeletonLines rows={4} />
        </div>
      ) : error ? (
        <LoadErrorState message={error} onRetry={reload} />
      ) : (
        <>
          {effectiveSource ? (
            <p className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
              Effective selection source: {effectiveSource}
            </p>
          ) : null}
          <Card>
            <div className="px-4 py-3 flex flex-col gap-2 border-b border-[var(--border-1)]">
              <label className="text-xs text-[var(--muted-foreground-1)]" htmlFor="org-sandbox-provider">
                Org provider
              </label>
              <select
                id="org-sandbox-provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="bg-[var(--input)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-xs px-2 py-1.5"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.configured ? "" : " (misconfigured)"}
                  </option>
                ))}
              </select>
              {providerId === "computesdk" ? (
                <input
                  type="text"
                  value={computesdkBackend}
                  onChange={(e) => setComputesdkBackend(e.target.value)}
                  placeholder="ComputeSDK backend — e2b, modal, daytona…"
                  aria-label="ComputeSDK backend"
                  className="bg-[var(--input)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-xs px-2 py-1.5 font-mono"
                />
              ) : null}
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="self-start text-[11px] font-semibold text-[var(--primary)] border border-[var(--primary)]/30 px-2.5 py-1 rounded-[var(--radius-button)]"
              >
                {saving ? "Saving…" : "Save org default"}
              </button>
              {notice ? <StatusNotice tone={notice.tone}>{notice.text}</StatusNotice> : null}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono">
                <thead className="bg-[var(--bg)] text-[10px] uppercase text-[var(--muted-foreground-2)]">
                  <tr>
                    <th className="p-2">Provider</th>
                    {matrixKeys.map(([, label]) => (
                      <th key={label} className="p-2">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-1)]">
                  {providers.map((row) => (
                    <tr key={row.id} className={row.id === providerId ? "bg-[var(--primary-soft)]/40" : ""}>
                      <td className="p-2 font-semibold text-[var(--fg)]">{row.label}</td>
                      {matrixKeys.map(([key, label]) => (
                        <td key={key} className="p-2 text-center">
                          <span className="sr-only">{row.matrix[key] ? `${label} yes` : `${label} no`}</span>
                          <span aria-hidden="true">{row.matrix[key] ? "✓" : "·"}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <ViewLink view="custom-agents" label="Bots" onNavigate={onNavigate} />
        </>
      )}
    </SectionShell>
  );
}

type LiveSettingsSection = "automations" | "mailbox" | "environments";

function LiveSettingsSectionBody({
  section,
  onNavigate,
}: {
  section: LiveSettingsSection;
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const setup = useSetupStatus();
  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const content =
    setup.state.kind === "error" ? (
      <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
    ) : status ? (
      section === "automations" ? (
        <Card>
          <ChecklistRow
            label="Automations enabled"
            ok={status.automations.enabled}
            detail='AUTOMATIONS_ENABLED kill switch — "false"/"0"/"off" stops every automation firing'
          />
          <ChecklistRow
            label="TypeSafe key"
            ok={status.automations.typeSafe}
            detail="TYPESAFE_API_KEY — System One judgments"
          />
        </Card>
      ) : section === "mailbox" ? (
        <Card>
          <ChecklistRow
            label="Custom mailbox address"
            ok={status.mailbox.addressOverride}
            detail="AGENT_MAILBOX override; the built-in default is used when unset."
          />
          <ChecklistRow
            label="Outbound email binding"
            ok={status.mailbox.sendEnabled}
            detail="SEND_EMAIL binding required for approved email sends."
          />
        </Card>
      ) : (
        <EnvironmentsSection status={status} />
      )
    ) : (
      <Card>
        <div role="status" className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
          Reading /api/setup/status…
        </div>
      </Card>
    );

  if (section === "automations") {
    return (
      <SectionShell
        title="Automations"
        description="Deployment switches the Automations view runs under — booleans from GET /api/setup/status. Triggers themselves are managed in the Automations view."
      >
        {content}
        <ViewLink view="automations" label="Open Automations" onNavigate={onNavigate} />
      </SectionShell>
    );
  }
  if (section === "mailbox") {
    return (
      <SectionShell
        title="Mailbox"
        description="Deployment-backed mailbox configuration. Only booleans are exposed; address values are never returned by the setup endpoint."
      >
        {content}
        <ViewLink view="inbox" label="Open Mailbox" onNavigate={onNavigate} />
      </SectionShell>
    );
  }
  return (
    <SectionShell
      title="Environments"
      description="Configuration the deployment itself proves — every row is a boolean from GET /api/setup/status."
    >
      {content}
    </SectionShell>
  );
}

type ApiKeyRow = {
  keyId: string;
  label: string;
  principal: string;
  scopes: string[];
  createdAt: number;
  revoked: boolean;
};

function ApiKeysSettingsSection(): JSX.Element {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [label, setLabel] = useState("integration");
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const response = await fetch("/api/api-keys");
    if (!response.ok) throw new Error(`API keys request failed: ${response.status}`);
    const body = (await response.json()) as { keys?: ApiKeyRow[] };
    setKeys(Array.isArray(body.keys) ? body.keys : []);
  };

  useEffect(() => {
    void reload().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, scopes: ["api:read", "api:write"] }),
      });
      if (!response.ok) throw new Error(`Mint failed: ${response.status}`);
      const body = (await response.json()) as { token?: string };
      setMintedToken(body.token ?? null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/api-keys?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Revoke failed: ${response.status}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionShell
      title="API keys"
      description="Mint org-scoped bearer keys for /api/v1. Keys are shown once at creation; store them like passwords."
    >
      <div data-testid="api-keys-settings" className="space-y-4">
        {error ? (
          <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 text-xs text-[var(--destructive)] font-mono">
            {error}
          </div>
        ) : null}
        <Card>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-mono text-[var(--muted-foreground-2)]">
              Label
              <input
                aria-label="API key label"
                className="mt-1 w-full border border-[var(--border-1)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)]"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <button
              type="button"
              aria-label="Mint API key"
              disabled={busy || !label.trim()}
              onClick={() => void mint()}
              className="border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-mono hover:bg-[var(--bg)] disabled:opacity-50"
            >
              Mint key
            </button>
          </div>
          {mintedToken ? (
            <div className="border-t border-[var(--border-1)] px-4 py-3 text-xs font-mono text-[var(--primary)] break-all">
              New key (copy now): {mintedToken}
            </div>
          ) : null}
        </Card>
        <Card>
          {keys.length === 0 ? (
            <div className="px-4 py-6 text-xs font-mono text-[var(--muted-foreground-2)]">No API keys yet.</div>
          ) : (
            keys.map((key) => (
              <div
                key={key.keyId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0"
              >
                <div>
                  <div className="text-sm font-semibold text-[var(--fg)]">{key.label}</div>
                  <div className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
                    {key.keyId} · {key.scopes.join(", ")}
                    {key.revoked ? " · revoked" : ""}
                  </div>
                </div>
                {!key.revoked ? (
                  <button
                    type="button"
                    aria-label={`Revoke ${key.label}`}
                    disabled={busy}
                    onClick={() => void revoke(key.keyId)}
                    className="text-[11px] font-mono border border-[var(--border-1)] px-2 py-1"
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            ))
          )}
        </Card>
      </div>
    </SectionShell>
  );
}

function ModelsSettingsSection(): JSX.Element {
  const setup = useSetupStatus();
  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  return (
    <SectionShell
      title="Models"
      description="Which agent CLI + model each delegation role runs — resolved live from ROLE_MODEL_MAP / ROLE_MODEL__* env vars. Read-only: the Worker reports env state; set vars at deploy time."
    >
      {setup.state.kind === "error" ? (
        <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
      ) : (
        <ModelsSection status={status} />
      )}
    </SectionShell>
  );
}

/**
 * The real settings content for one section. Each data-backed section owns
 * its hooks so static sections do not issue unrelated API requests.
 */
export function SettingsSectionBody({
  section,
  onNavigate,
  onSignOut,
}: {
  section: SettingsSectionId;
  onNavigate?: (view: AppNavView) => void;
  onSignOut?: () => Promise<void>;
}): JSX.Element {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";

  if (section === "account") {
    return (
      <SectionShell
        title="Account"
        description="Who you are to this deployment — the identity GET /api/whoami proves, plus the auth lane and sign-out."
      >
        <AccountSection onSignOut={onSignOut} />
      </SectionShell>
    );
  }

  if (section === "api-keys") return <ApiKeysSettingsSection />;

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

  if (section === "automations" || section === "mailbox" || section === "environments") {
    return <LiveSettingsSectionBody section={section} onNavigate={onNavigate} />;
  }

  if (section === "models") return <ModelsSettingsSection />;

  if (section === "sandbox") return <SandboxOrgSettingsSection onNavigate={onNavigate} />;

  if (section === "experimental") {
    return (
      <SectionShell
        title="Experimental"
        description="Opt-in feature flags. These are set via wrangler vars/secrets at deploy time — this list mirrors wrangler.jsonc's vars comment block; it cannot read live values."
      >
        <Card>
          {EXPERIMENTAL_FLAGS.map((flag) => (
            <div key={flag.flag} className="border-b border-[var(--border-1)] px-4 py-3 last:border-b-0">
              <div className="font-mono text-xs font-semibold text-[var(--primary)]">{flag.flag}</div>
              <div className="mt-0.5 text-xs text-[var(--fg)]">{flag.effect}</div>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--muted-foreground-2)]">{flag.related}</div>
            </div>
          ))}
        </Card>
        <Card>
          <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
            Kill switches (env.ts)
          </div>
          {KILL_SWITCHES.map((flag) => (
            <div key={flag.flag} className="border-b border-[var(--border-1)] px-4 py-3 last:border-b-0">
              <div className="font-mono text-xs font-semibold text-[var(--primary)]">{flag.flag}</div>
              <div className="mt-0.5 text-xs text-[var(--fg)]">{flag.effect}</div>
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
        <div className="border-b border-[var(--border-1)] px-4 py-2.5">
          <div className="text-xs font-medium text-[var(--fg)]">Serving host</div>
          <div className="font-mono text-[11px] text-[var(--muted-foreground-2)]">{hostname || "unknown"}</div>
        </div>
        <div className="border-b border-[var(--border-1)] px-4 py-2.5">
          <div className="text-xs font-medium text-[var(--fg)]">Dashboard package</div>
          <div className="font-mono text-[11px] text-[var(--muted-foreground-2)]">
            @shiba/frontend@{dashboardVersion}
          </div>
        </div>
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
      <div className="px-4 py-3 border-b border-[var(--border-1)] flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="New repository URL"
            className="flex-1 bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60 transition-colors"
          />
          <button
            type="button"
            onClick={add}
            className="text-[11px] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)] font-medium py-1.5 px-3 rounded-[var(--radius-button)] transition-colors shrink-0"
          >
            Save repo
          </button>
        </div>
        {error ? <span className="text-[11px] text-[var(--destructive)]">{error}</span> : null}
      </div>
      {repos.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
          None saved yet — repos you run tasks against are saved automatically too.
        </div>
      ) : (
        repos.map((repo) => (
          <div
            key={repo}
            className="border-b border-[var(--border-1)] px-4 py-3 last:border-b-0 flex items-center justify-between gap-3"
          >
            <span className="font-mono text-xs text-[var(--fg)] truncate">{repo}</span>
            <button
              type="button"
              onClick={() => removeRepo(repo)}
              aria-label={`Remove ${repo}`}
              className="shrink-0 text-[11px] bg-transparent hover:bg-[var(--destructive-soft)] border border-[var(--border-1)] hover:border-[var(--destructive)]/50 text-[var(--muted-foreground-2)] hover:text-[var(--destructive)] font-medium py-1 px-2.5 rounded-[var(--radius-button)] transition-colors"
            >
              Remove
            </button>
          </div>
        ))
      )}
    </Card>
  );
}
