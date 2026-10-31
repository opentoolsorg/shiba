/**
 * IntegrationsView — third-party apps and channels wired into this
 * deployment. Apps (GitHub, and soon Notion/Linear/Jira/Asana), chat &
 * approval channels (Slack, Telegram, Discord), and email. AI-agent
 * providers live on the Agents & MCP page; worker plumbing lives in
 * Settings. Every row is backed by a real API read
 * (`/api/setup/status`, `/api/mailboxes`) or says honestly that it isn't
 * supported yet — no fake toggles.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { AcpProvidersSnapshot, McpCapabilityDirectoryEntry, McpCapabilityInvocationReceipt } from "@shiba/shared";
import { type SetupStatus, useMailboxes, useSetupStatus } from "../live-status";
import { useSavedSkills } from "../saved";
import type { AppNavView } from "./AppNavRail";
import { CapabilityCatalog, type CapabilityCatalogItem } from "./CapabilityCatalog";
import { GmailConnection } from "./GmailConnection";
import { LoadErrorState } from "./LoadErrorState";
import { McpCoworkerPanel } from "./McpCoworkerPanel";
import { providerLifecycleStatus, providerTestDescription } from "./provider-lifecycle";
import { ToneChip } from "./ToneChip";
import { ReasonNetworkSetup } from "./ReasonNetworkSetup";
import { IntegrationCatalogDirectory } from "./IntegrationCatalogDirectory";
import { CuratedMcpConnections } from "./CuratedMcpConnections";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";

function IntegrationRow({
  name,
  status,
  children,
  action,
  muted = false,
  "data-testid": dataTestId,
}: {
  name: string;
  status: ReactNode;
  children: ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
  muted?: boolean;
  "data-testid"?: string;
}): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      className={`flex flex-col gap-2 border-b border-[var(--border-1)] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${muted ? "opacity-60" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-[var(--fg)]">{name}</span>
          {status}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">{children}</div>
      </div>
      {action?.href ? (
        <a
          href={action.href}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 sm:self-center"
        >
          {action.label}
        </a>
      ) : action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 self-start rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 sm:self-center"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function IntegrationGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section>
      <p className="mb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        {title}
      </p>
      <p className="mb-2 text-xs text-[var(--muted-foreground-2)]">{hint}</p>
      <div className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
        {children}
      </div>
    </section>
  );
}

function slackChip(slack: SetupStatus["slack"] | undefined, loading: boolean): JSX.Element {
  if (loading) return <ToneChip tone="neutral" label="Checking…" />;
  if (!slack) return <ToneChip tone="neutral" label="Not set up" />;
  const configured = slack.signingSecret && slack.botToken && slack.approvers > 0;
  const partial =
    slack.signingSecret || slack.botToken || slack.approvers > 0 || slack.channelRepos;
  if (configured) return <ToneChip tone="pending" label="Configured" />;
  if (partial) return <ToneChip tone="pending" label="Partially configured" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

function githubChip(github: SetupStatus["github"] | undefined, loading: boolean): JSX.Element {
  if (loading) return <ToneChip tone="neutral" label="Checking…" />;
  if (!github) return <ToneChip tone="neutral" label="Not set up" />;
  if (github.publish && github.webhookSecret) return <ToneChip tone="pending" label="Configured" />;
  if (github.publish || github.webhookSecret || github.app)
    return <ToneChip tone="pending" label="Partially configured" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

function linearChip(linear: SetupStatus["linear"] | undefined, loading: boolean): JSX.Element {
  if (loading) return <ToneChip tone="neutral" label="Checking…" />;
  if (!linear) return <ToneChip tone="neutral" label="Not set up" />;
  if (linear.webhookSecret && linear.apiToken && linear.defaultRepo) {
    return <ToneChip tone="pending" label="Configured" />;
  }
  if (linear.webhookSecret || linear.apiToken || linear.defaultRepo) {
    return <ToneChip tone="pending" label="Partially configured" />;
  }
  return <ToneChip tone="neutral" label="Not set up" />;
}

export function IntegrationsView({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();
  const savedSkills = useSavedSkills();
  const [showCapabilityCatalog, setShowCapabilityCatalog] = useState(false);
  const [showSetupDetails, setShowSetupDetails] = useState(false);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [externalMcpServerCount, setExternalMcpServerCount] = useState<number | undefined>(undefined);
  const [externalMcpCatalogConnections, setExternalMcpCatalogConnections] = useState<
    IntegrationBindingInputs["externalMcpCatalogConnections"]
  >(undefined);
  const [externalMcpLoading, setExternalMcpLoading] = useState(true);
  const [providers, setProviders] = useState<AcpProvidersSnapshot | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [toolDirectory, setToolDirectory] = useState<McpCapabilityDirectoryEntry[]>([]);
  const [toolDirectoryError, setToolDirectoryError] = useState<string | null>(null);
  const [invocations, setInvocations] = useState<McpCapabilityInvocationReceipt[]>([]);
  const [invocationHistoryError, setInvocationHistoryError] = useState<string | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [setupSearch, setSetupSearch] = useState("");
  const [libraryCatalog, setLibraryCatalog] = useState<Array<{ slug: string; name: string; summary: string; installed: boolean }>>([]);
  const [spacesCatalog, setSpacesCatalog] = useState<Array<{ id: string; name: string; template: string }>>([]);

  const setupQuery = setupSearch.trim().toLowerCase();
  const rowVisible = (name: string) => !setupQuery || name.toLowerCase().includes(setupQuery);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setGmailLoading(true);
    void fetch("/api/connections/gmail", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled) setGmailConnected(false);
          return;
        }
        const body = (await response.json()) as { configured?: boolean; connection?: unknown };
        if (!cancelled) setGmailConnected(Boolean(body.configured && body.connection));
      })
      .catch(() => {
        if (!cancelled) setGmailConnected(false);
      })
      .finally(() => {
        if (!cancelled) setGmailLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setExternalMcpLoading(true);
    void Promise.all([
      fetch("/api/v1/mcp/servers", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch("/api/v1/mcp/catalog-connections", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      }),
    ])
      .then(async ([serversResponse, catalogResponse]) => {
        if (!serversResponse.ok) {
          if (!cancelled) setExternalMcpServerCount(0);
        } else {
          const body = (await serversResponse.json()) as { servers?: unknown[] };
          if (!cancelled) setExternalMcpServerCount(Array.isArray(body.servers) ? body.servers.length : 0);
        }
        if (!catalogResponse.ok) {
          if (!cancelled) setExternalMcpCatalogConnections([]);
          return;
        }
        const catalogBody = (await catalogResponse.json()) as {
          connections?: IntegrationBindingInputs["externalMcpCatalogConnections"];
        };
        if (!cancelled) {
          setExternalMcpCatalogConnections(Array.isArray(catalogBody.connections) ? catalogBody.connections : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalMcpServerCount(0);
          setExternalMcpCatalogConnections([]);
        }
      })
      .finally(() => {
        if (!cancelled) setExternalMcpLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [catalogRefresh]);

  useEffect(() => {
    if (!showCapabilityCatalog) return;
    let cancelled = false;
    const controller = new AbortController();
    const refreshSuffix = catalogRefresh === 0 ? "" : `?refresh=${catalogRefresh}`;
    const requestOptions = { credentials: "same-origin", cache: "no-store", signal: controller.signal } as const;
    void fetch(`/api/providers${refreshSuffix}`, requestOptions)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Provider catalog unavailable (${response.status}).`);
        const value = (await response.json()) as AcpProvidersSnapshot;
        if (!value || !Array.isArray(value.providers)) throw new Error("Provider catalog returned an invalid response.");
        if (!cancelled) {
          setProviders(value);
          setProvidersError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setProvidersError(error instanceof Error ? error.message : String(error));
      });
    void fetch(`/api/capabilities?limit=50${catalogRefresh === 0 ? "" : `&refresh=${catalogRefresh}`}`, requestOptions)
      .then(async (response) => {
        if (!response.ok) throw new Error(`MCP tool directory unavailable (${response.status}).`);
        const value = (await response.json()) as { entries?: McpCapabilityDirectoryEntry[] };
        if (!value || !Array.isArray(value.entries)) throw new Error("MCP tool directory returned an invalid response.");
        if (!cancelled) {
          setToolDirectory(value.entries);
          setToolDirectoryError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setToolDirectoryError(error instanceof Error ? error.message : String(error));
      });
    void fetch(`/api/capabilities/invocations?limit=25${catalogRefresh === 0 ? "" : `&refresh=${catalogRefresh}`}`, requestOptions)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tool call history unavailable (${response.status}).`);
        const value = (await response.json()) as { entries?: McpCapabilityInvocationReceipt[] };
        if (!value || !Array.isArray(value.entries)) throw new Error("Tool call history returned an invalid response.");
        if (!cancelled) { setInvocations(value.entries); setInvocationHistoryError(null); }
      })
      .catch((error: unknown) => {
        if (!cancelled) setInvocationHistoryError(error instanceof Error ? error.message : String(error));
      });
    void fetch("/api/skills/library", requestOptions)
      .then(async (response) => {
        if (!response.ok) return;
        const value = (await response.json()) as { skills?: Array<{ slug: string; name: string; summary: string; installed: boolean }> };
        if (!cancelled && Array.isArray(value.skills)) setLibraryCatalog(value.skills);
      })
      .catch(() => { /* optional catalog enrichment */ });
    void fetch("/api/spaces", requestOptions)
      .then(async (response) => {
        if (!response.ok) return;
        const value = (await response.json()) as { spaces?: Array<{ id: string; name: string; template: string }> };
        if (!cancelled && Array.isArray(value.spaces)) setSpacesCatalog(value.spaces);
      })
      .catch(() => { /* optional catalog enrichment */ });
    return () => { cancelled = true; controller.abort(); };
  }, [showCapabilityCatalog, catalogRefresh]);

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const loading = setup.state.kind === "loading";
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;

  const failed = setup.state.kind === "error" ? setup.state : null;
  const reloadAll = () => {
    setup.reload();
    mailboxes.reload();
  };

  const bindingInputs = useMemo<IntegrationBindingInputs>(
    () => ({
      setupLoading: loading,
      setup: status,
      mailboxCount: mailboxList?.length,
      mailboxLoading: mailboxes.state.kind === "loading",
      gmailConnected,
      gmailLoading,
      externalMcpServerCount,
      externalMcpCatalogConnections,
      externalMcpLoading,
    }),
    [
      loading,
      status,
      mailboxList,
      mailboxes.state.kind,
      gmailConnected,
      gmailLoading,
      externalMcpServerCount,
      externalMcpCatalogConnections,
      externalMcpLoading,
    ],
  );

  const catalogItems = useMemo<CapabilityCatalogItem[]>(() => {
    const items: CapabilityCatalogItem[] = [];
    if (status) {
      const githubConfigured = status.github.publish && status.github.webhookSecret;
      const githubPartial = status.github.publish || status.github.webhookSecret || status.github.app;
      items.push({
        id: "connector:github", name: "GitHub", kind: "connector",
        status: githubConfigured ? "configured" : githubPartial ? "partiallyConfigured" : "available",
        category: "Code hosting",
        summary: githubConfigured ? "Deployment credentials are present; live repository access is not verified here." : "GitHub publishing and webhook credentials are not fully configured.",
        description: "Open pull requests and react to repository events. Credential presence comes from the setup status endpoint.",
        capabilities: ["Open pull requests", "React to repository events"],
        authNote: githubConfigured ? "Configured credentials are present. This view does not verify provider access." : "Connect through deployment settings; the dashboard does not start OAuth here.",
        source: status,
      });
      const linearConfigured = status.linear.webhookSecret && status.linear.apiToken && status.linear.defaultRepo;
      items.push({
        id: "connector:linear", name: "Linear", kind: "connector",
        status: linearConfigured ? "configured" : status.linear.webhookSecret || status.linear.apiToken || status.linear.defaultRepo ? "partiallyConfigured" : "available",
        category: "Project management",
        summary: "Issue delegation requires a webhook secret, API token, and default repository URL.",
        capabilities: ["Delegate issue sessions"],
        authNote: linearConfigured ? "Configuration is present; live workspace access has not been verified." : "Not fully configured in deployment settings.",
        source: status,
      });
      const slackConfigured = status.slack.signingSecret && status.slack.botToken;
      items.push({
        id: "connector:slack", name: "Slack", kind: "connector",
        status: slackConfigured && status.slack.approvers > 0 ? "configured" : status.slack.signingSecret || status.slack.botToken || status.slack.approvers > 0 ? "partiallyConfigured" : "available",
        category: "Chat and approvals",
        summary: "Chat and run approvals through a deployment-configured Slack app.",
        capabilities: ["Queue tasks", "Approve runs"],
        authNote: slackConfigured ? "Credentials are present; live Slack access is not verified here." : "Configure a Slack app in deployment settings.",
        source: status,
      });
    }
    for (const mailbox of mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : []) {
      items.push({
        id: `mailbox:${mailbox.address}`, name: mailbox.address, kind: "connector", status: "configured",
        category: "Email", summary: "Mailbox is listed by the authenticated mailbox API.",
        capabilities: ["Inbound triage", "Draft email"],
        authNote: "Outbound email remains approval-gated.",
      });
    }
    if (providers) {
      for (const provider of providers.providers) {
        items.push({
          id: `provider:${provider.id}`, name: provider.label, kind: "mcp",
          status: providerLifecycleStatus(provider.connection),
          category: "AI agent provider", summary: provider.blurb,
          description: `${provider.protocol.toUpperCase()} provider managed on the Providers page.`,
          capabilities: Object.entries(provider.capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
          authNote: providerTestDescription(provider.connection),
          source: provider,
        });
      }
    }
    for (const skill of savedSkills.skills) {
      items.push({
        id: `skill:${skill.id}`, name: skill.name, kind: "skill", status: skill.status === "active" ? "configured" : "available",
        category: "Saved procedure", summary: skill.instructions || `Version ${skill.version} is a draft without instruction text.`,
        description: `${skill.status} skill version ${skill.version}. ${skill.sourceUrl ? `Source provenance: ${skill.sourceUrl}. ` : ""}Reviewed text is guidance, not an executable connector.`,
        capabilities: ["Provide task instructions"], source: skill,
      });
    }
    for (const legacy of savedSkills.legacySkills) {
      items.push({
        id: `legacy-skill:${legacy.id}`, name: legacy.name, kind: "skill", status: "available",
        category: "Legacy local skill", summary: legacy.notes || "Browser-local notes are waiting to be imported.",
        description: "This legacy entry is not active. Import it from Skills to create an unreviewed server draft.",
        capabilities: [], source: legacy.name,
      });
    }
    for (const tool of toolDirectory) {
      items.push({
        id: tool.id,
        name: tool.name,
        kind: "mcp",
        status: "available",
        category: "Shiba MCP tool",
        summary: tool.description,
        description: `${tool.description} Discovery is based on the same handler registry published by Shiba MCP.`,
        capabilities: [tool.requiredScope, tool.writeEffect.replaceAll("_", " ")],
        catalogOnly: true,
        version: tool.version,
        requiredScope: tool.requiredScope,
        writeEffect: tool.writeEffect,
        approval: tool.approval,
        verification: tool.verification,
        source: tool.source,
      });
    }
    for (const entry of libraryCatalog) {
      items.push({
        id: `library-skill:${entry.slug}`,
        name: entry.name,
        kind: "skill",
        status: entry.installed ? "configured" : "available",
        category: "Curated skill library",
        summary: entry.summary,
        description: "Install from Skills → Library creates a draft skill until you activate it in review.",
        capabilities: ["Install to draft", "Activate after review"],
        authNote: entry.installed ? "Installed as a draft skill in this org." : "Not installed in this org yet.",
      });
    }
    for (const space of spacesCatalog) {
      items.push({
        id: `space:${space.id}`,
        name: space.name,
        kind: "connector",
        status: "configured",
        category: "Space",
        summary: `Template: ${space.template}. Spaces group skills, repos, and automations for a workflow desk.`,
        capabilities: ["Group skills and runs"],
        authNote: "Managed on the Spaces page; MCP agents queue runs separately via queue_run.",
      });
    }
    items.unshift({
      id: "mcp:coworker:grok-bot",
      name: "Grok Bot MCP coworker",
      kind: "mcp",
      status: status?.doctor?.ok ? "configured" : "partiallyConfigured",
      category: "MCP coworker",
      summary: "External agent connector at /mcp with sandbox:exec + runs:read.",
      description: "Mint shb_ tokens for principals like grok-bot; queue_run returns pending_approval until a human approves.",
      capabilities: ["queue_run", "run_status", "list_runs", "list_approvals"],
      authNote: "Live KV mint and Grok Bot connector wiring require deployment secrets — see Agents & MCP.",
    });
    return items;
  }, [status, mailboxes.state, providers, savedSkills, toolDirectory, libraryCatalog, spacesCatalog]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
            <span>Integrations</span>
          </h2>
          <p className="text-xs text-[var(--muted-foreground-2)]">
            Third-party apps and channels your agents can reach — connect once, use everywhere.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {showCapabilityCatalog ? (
            <button
              type="button"
              onClick={() => {
                setup.reload();
                mailboxes.reload();
                setCatalogRefresh((value) => value + 1);
              }}
              className="border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold hover:bg-[var(--card-hover)]"
              aria-label="Refresh integration status"
            >
              Refresh status
            </button>
          ) : null}
          {!showCapabilityCatalog ? (
            <button
              type="button"
              onClick={() => setShowSetupDetails((shown) => !shown)}
              className="border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold hover:bg-[var(--card-hover)]"
              aria-pressed={showSetupDetails}
            >
              {showSetupDetails ? "Hide setup details" : "Show setup details"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setShowCapabilityCatalog((shown) => !shown);
              if (!showCapabilityCatalog) setShowSetupDetails(false);
            }}
            className="border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold hover:bg-[var(--card-hover)]"
            aria-pressed={showCapabilityCatalog}
          >
            {showCapabilityCatalog ? "Back to integration catalog" : "Browse capability catalog"}
          </button>
        </div>
      </div>
      {showCapabilityCatalog ? (
        <div className="min-h-0 flex-1">
          {providersError ? <p className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning-fg)]" role="status">{providersError} Provider state may be stale. Retry refresh before relying on the last displayed state.</p> : null}
          {toolDirectoryError ? <p className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning-fg)]" role="status">{toolDirectoryError} MCP schemas are withheld from the dashboard directory.</p> : null}
          <CapabilityCatalog items={catalogItems} invocations={invocations} invocationHistoryError={invocationHistoryError} onConfigure={(item) => onNavigate?.(item.kind === "skill" ? "skills" : item.kind === "mcp" ? "providers" : "settings")} onReconnect={(item) => onNavigate?.(item.kind === "mcp" ? "providers" : "settings")} onConnectMcp={() => onNavigate?.("agents")} onViewToolHistory={() => onNavigate?.("approvals")} />
        </div>
      ) : showSetupDetails ? (
        <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {failed ? <LoadErrorState message={failed.message} onRetry={reloadAll} /> : null}

          <McpCoworkerPanel onOpenAgents={() => onNavigate?.("agents")} />

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
              Search integrations
            </span>
            <input
              type="search"
              value={setupSearch}
              onChange={(event) => setSetupSearch(event.target.value)}
              placeholder="Filter by name (GitHub, Slack, Grok Bot, …)"
              className="w-full max-w-md rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--fg)]"
              aria-label="Search integrations"
            />
          </label>

          <ReasonNetworkSetup />

          <IntegrationGroup
            title="Apps"
            hint="OAuth apps your agents work with. AI-agent providers live in Agents & MCP."
          >
            {rowVisible("GitHub") ? (
            <IntegrationRow
              name="GitHub"
              status={githubChip(status?.github, loading)}
              action={
                status && !(status.github.publish && status.github.webhookSecret)
                  ? {
                      label: "Connect ↗",
                      href: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=shiba",
                    }
                  : undefined
              }
            >
              <p>Open pull requests and react to repo events. PAT or GitHub App installation tokens (multi-repo).</p>
              {status && !(status.github.publish && status.github.webhookSecret) ? (
                <p className="mt-0.5 text-[11px]">
                  {status.github.publish
                    ? "Publish credentials present — add GITHUB_WEBHOOK_SECRET for automations: npx wrangler secret put GITHUB_WEBHOOK_SECRET."
                    : "Set GITHUB_TOKEN or GitHub App env vars in deployment settings; set GITHUB_WEBHOOK_SECRET with npx wrangler secret put GITHUB_WEBHOOK_SECRET."}
                  {status.github.app ? " App credentials detected." : null}
                </p>
              ) : null}
            </IntegrationRow>
            ) : null}
            {rowVisible("Linear") ? (
            <IntegrationRow
              name="Linear"
              status={linearChip(status?.linear, loading)}
              action={{
                label: "Agent docs ↗",
                href: "/docs/linear-agent-session/",
              }}
              data-testid="integration-linear"
            >
              <p>Agent sessions: delegate an issue to Shiba and stream progress back via agent activities.</p>
              <p className="mt-0.5 text-[11px]">
                Requires LINEAR_WEBHOOK_SECRET, an API token, and LINEAR_DEFAULT_REPO_URL. Live workspace not verified from mocks.
              </p>
            </IntegrationRow>
            ) : null}
          </IntegrationGroup>

          <IntegrationGroup
            title="Chat & approval channels"
            hint="Chat apps where you can queue tasks and approve runs."
          >
            {rowVisible("Slack") ? (
            <IntegrationRow
              name="Slack"
              status={slackChip(status?.slack, loading)}
              action={
                status && !(status.slack.signingSecret && status.slack.botToken)
                  ? { label: "Open Slack apps ↗", href: "https://api.slack.com/apps" }
                  : undefined
              }
            >
              <p>Approve runs and talk to your agents from Slack.</p>
              {status && !(status.slack.signingSecret && status.slack.botToken) ? (
                <p className="mt-0.5 text-[11px]">
                  {status.slack.signingSecret || status.slack.botToken
                    ? "Setup is partially complete — finish it in your deployment settings."
                    : "Not set up yet — connect a Slack app in your deployment settings."}
                </p>
              ) : null}
            </IntegrationRow>
            ) : null}
            {rowVisible("Telegram") ? (
            <IntegrationRow
              name="Telegram"
              status={<ToneChip tone="neutral" label="Available via deployment" />}
              action={{ label: "Open BotFather ↗", href: "https://t.me/BotFather" }}
            >
              <p>Send tasks and approvals through a Telegram bot.</p>
              <p className="mt-0.5 text-[11px]">
                Set up by your deployment operator — the dashboard can&apos;t verify it.
              </p>
            </IntegrationRow>
            ) : null}
            {rowVisible("Discord") ? (
            <IntegrationRow
              name="Discord"
              status={<ToneChip tone="neutral" label="Available via deployment" />}
              action={{
                label: "Open Discord portal ↗",
                href: "https://discord.com/developers/applications",
              }}
            >
              <p>Run commands and progress posts in Discord.</p>
              <p className="mt-0.5 text-[11px]">
                Set up by your deployment operator — the dashboard can&apos;t verify it.
              </p>
            </IntegrationRow>
            ) : null}
          </IntegrationGroup>

          <IntegrationGroup title="Email" hint="Inbound triage, approval-gated outbound mail, and read-only Gmail.">
            {rowVisible("Gmail") || rowVisible("Email") ? <GmailConnection /> : null}
            {rowVisible("Mailbox") ? (
            <IntegrationRow
              name="Mailbox"
              status={
                mailboxList === undefined ? (
                  <ToneChip
                    tone="neutral"
                    label={mailboxes.state.kind === "error" ? "Status error" : mailboxes.state.kind === "loading" ? "Checking…" : "Not set up"}
                  />
                ) : mailboxList.length > 0 ? (
                  <ToneChip tone="ok" label={`${mailboxList.length} connected`} />
                ) : (
                  <ToneChip tone="neutral" label="Not set up" />
                )
              }
              action={
                onNavigate
                  ? { label: "Open Mailbox →", onClick: () => onNavigate("inbox") }
                  : undefined
              }
            >
              <p>Inbound mail triage and drafts; outbound sends wait for your approval.</p>
              {mailboxList && mailboxList.length > 0 ? (
                <p className="mt-0.5 font-mono text-[11px]">
                  {mailboxList
                    .slice(0, 4)
                    .map((mailbox) => mailbox.address)
                    .join(" · ")}
                  {mailboxList.length > 4 ? ` · +${mailboxList.length - 4} more` : ""}
                </p>
              ) : null}
            </IntegrationRow>
            ) : null}
          </IntegrationGroup>
        </div>
      </div>
      ) : (
        <>
          {failed ? (
            <div className="border-b border-[var(--border-1)] px-4 py-2 lg:px-8">
              <LoadErrorState message={failed.message} onRetry={reloadAll} />
            </div>
          ) : null}
          <div className="border-b border-[var(--border-1)] px-4 py-4 lg:px-8">
            <div className="mx-auto max-w-6xl">
              <CuratedMcpConnections onChanged={() => setCatalogRefresh((value) => value + 1)} />
            </div>
          </div>
          <IntegrationCatalogDirectory bindingInputs={bindingInputs} />
        </>
      )}
    </div>
  );
}
