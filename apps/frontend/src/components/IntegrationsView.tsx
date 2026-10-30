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
import { ToneChip } from "./ToneChip";

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
  if (configured) return <ToneChip tone="ok" label="Connected" />;
  if (partial) return <ToneChip tone="pending" label="Partially set up" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

function githubChip(github: SetupStatus["github"] | undefined, loading: boolean): JSX.Element {
  if (loading) return <ToneChip tone="neutral" label="Checking…" />;
  if (!github) return <ToneChip tone="neutral" label="Not set up" />;
  if (github.publish && github.webhookSecret) return <ToneChip tone="ok" label="Connected" />;
  if (github.publish || github.webhookSecret || github.app)
    return <ToneChip tone="pending" label="Partially set up" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

function linearChip(linear: SetupStatus["linear"] | undefined, loading: boolean): JSX.Element {
  if (loading) return <ToneChip tone="neutral" label="Checking…" />;
  if (!linear) return <ToneChip tone="neutral" label="Not set up" />;
  if (linear.webhookSecret && linear.apiToken && linear.defaultRepo) {
    return <ToneChip tone="ok" label="Configured (mock)" />;
  }
  if (linear.webhookSecret || linear.apiToken || linear.defaultRepo) {
    return <ToneChip tone="pending" label="Partially set up" />;
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
  const [showCatalog, setShowCatalog] = useState(false);
  const [providers, setProviders] = useState<AcpProvidersSnapshot | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [toolDirectory, setToolDirectory] = useState<McpCapabilityDirectoryEntry[]>([]);
  const [toolDirectoryError, setToolDirectoryError] = useState<string | null>(null);
  const [invocations, setInvocations] = useState<McpCapabilityInvocationReceipt[]>([]);
  const [invocationHistoryError, setInvocationHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!showCatalog) return;
    let cancelled = false;
    void fetch("/api/providers", { credentials: "same-origin", cache: "no-store" })
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
    void fetch("/api/capabilities?limit=50", { credentials: "same-origin", cache: "no-store" })
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
    void fetch("/api/capabilities/invocations?limit=25", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tool call history unavailable (${response.status}).`);
        const value = (await response.json()) as { entries?: McpCapabilityInvocationReceipt[] };
        if (!value || !Array.isArray(value.entries)) throw new Error("Tool call history returned an invalid response.");
        if (!cancelled) { setInvocations(value.entries); setInvocationHistoryError(null); }
      })
      .catch((error: unknown) => {
        if (!cancelled) setInvocationHistoryError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [showCatalog]);

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const loading = setup.state.kind === "loading";
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;

  const failed = setup.state.kind === "error" ? setup.state : null;
  const reloadAll = () => {
    setup.reload();
    mailboxes.reload();
  };

  const catalogItems = useMemo<CapabilityCatalogItem[]>(() => {
    const items: CapabilityCatalogItem[] = [];
    if (status) {
      const githubConfigured = status.github.publish && status.github.webhookSecret;
      items.push({
        id: "github", name: "GitHub", kind: "connector",
        status: githubConfigured ? "configured" : "available",
        category: "Code hosting",
        summary: githubConfigured ? "Deployment credentials are present; live repository access is not verified here." : "GitHub publishing and webhook credentials are not fully configured.",
        description: "Open pull requests and react to repository events. Credential presence comes from the setup status endpoint.",
        capabilities: ["Open pull requests", "React to repository events"],
        authNote: githubConfigured ? "Configured credentials are present. This view does not verify provider access." : "Connect through deployment settings; the dashboard does not start OAuth here.",
        source: status,
      });
      const linearConfigured = status.linear.webhookSecret && status.linear.apiToken && status.linear.defaultRepo;
      items.push({
        id: "linear", name: "Linear", kind: "connector",
        status: linearConfigured ? "configured" : "available",
        category: "Project management",
        summary: "Issue delegation requires a webhook secret, API token, and default repository URL.",
        capabilities: ["Delegate issue sessions"],
        authNote: linearConfigured ? "Configuration is present; live workspace access has not been verified." : "Not fully configured in deployment settings.",
        source: status,
      });
      const slackConfigured = status.slack.signingSecret && status.slack.botToken;
      items.push({
        id: "slack", name: "Slack", kind: "connector",
        status: slackConfigured ? "configured" : "available",
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
        const phase = provider.connection.phase;
        const live = phase === "connected" && provider.connection.testOk === true;
        const configured = phase === "connected" || phase === "failed";
        items.push({
          id: `provider:${provider.id}`, name: provider.label, kind: "mcp",
          status: live ? "liveVerified" : configured ? "configured" : "available",
          category: "AI agent provider", summary: provider.blurb,
          description: `${provider.protocol.toUpperCase()} provider managed on the Providers page.`,
          capabilities: Object.entries(provider.capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
          authNote: live ? "Provider test succeeded according to the current provider snapshot." : configured ? (provider.connection.testOk === false ? "Connected, but the latest provider test failed." : "Connected state is reported; no successful test is recorded.") : "Not connected. Configure on the Providers page.",
          source: provider,
        });
      }
    }
    for (const skill of savedSkills) {
      items.push({
        id: `skill:${skill.id}`, name: skill.name, kind: "skill", status: "configured",
        category: "Saved procedure", summary: skill.notes || "Saved in this browser for use as task guidance.",
        description: skill.repoUrl ? `Procedure saved from ${skill.repoUrl}.` : "User-saved instruction procedure. This is guidance, not an executable connector.",
        capabilities: ["Provide task instructions"], source: skill,
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
    return items;
  }, [status, mailboxes.state, providers, savedSkills, toolDirectory]);

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
        <button type="button" onClick={() => setShowCatalog((shown) => !shown)} className="shrink-0 border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold hover:bg-[var(--card-hover)]" aria-pressed={showCatalog}>
          {showCatalog ? "Show setup details" : "Browse capability catalog"}
        </button>
      </div>
      {showCatalog ? (
        <div className="min-h-0 flex-1">
          {providersError ? <p className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning-fg)]" role="status">{providersError} Provider entries are unavailable; other catalog items use their own API evidence.</p> : null}
          {toolDirectoryError ? <p className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning-fg)]" role="status">{toolDirectoryError} MCP schemas are withheld from the dashboard directory.</p> : null}
          <CapabilityCatalog items={catalogItems} invocations={invocations} invocationHistoryError={invocationHistoryError} onConfigure={(item) => onNavigate?.(item.kind === "skill" ? "skills" : item.kind === "mcp" ? "providers" : "settings")} onReconnect={(item) => onNavigate?.(item.kind === "mcp" ? "providers" : "settings")} onConnectMcp={() => onNavigate?.("agents")} onViewToolHistory={() => onNavigate?.("approvals")} />
        </div>
      ) : <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {failed ? <LoadErrorState message={failed.message} onRetry={reloadAll} /> : null}

          <IntegrationGroup
            title="Apps"
            hint="OAuth apps your agents work with. AI-agent providers live in Agents & MCP."
          >
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
          </IntegrationGroup>

          <IntegrationGroup
            title="Chat & approval channels"
            hint="Chat apps where you can queue tasks and approve runs."
          >
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
          </IntegrationGroup>

          <IntegrationGroup title="Email" hint="Inbound triage, approval-gated outbound mail, and read-only Gmail.">
            <GmailConnection />
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
          </IntegrationGroup>
        </div>
      </div>}
    </div>
  );
}
