/**
 * IntegrationsView — third-party apps and channels wired into this
 * deployment. Apps (GitHub, and soon Notion/Linear/Jira/Asana), chat &
 * approval channels (Slack, Telegram, Discord), and email. AI-agent
 * providers live on the Agents & MCP page; worker plumbing lives in
 * Settings. Every row is backed by a real API read
 * (`/api/setup/status`, `/api/mailboxes`) or says honestly that it isn't
 * supported yet — no fake toggles.
 */
import type { JSX, ReactNode } from "react";
import { type SetupStatus, useMailboxes, useSetupStatus } from "../live-status";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { ToneChip } from "./ToneChip";

const ACTION_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-none border border-[#d3d2c8] bg-[#fffef8] px-3 py-1.5 text-[11px] font-mono font-medium text-[#1c1cc8] transition-colors hover:border-[#0000a8]/40 hover:bg-[#0000a8]/5 active:translate-y-px";

function Logo({ src, name }: { src?: string; name: string }): JSX.Element {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-none border border-[#e0ded5] bg-white">
      {src ? (
        <img src={src} alt="" width={22} height={22} className="size-[22px] object-contain" />
      ) : (
        <span className="text-sm font-semibold text-[#222320]">{name.slice(0, 1)}</span>
      )}
    </span>
  );
}

function IntegrationCard({
  name,
  logo,
  status,
  children,
  action,
  muted = false,
}: {
  name: string;
  logo?: string;
  status: ReactNode;
  children: ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
  muted?: boolean;
}): JSX.Element {
  return (
    <div
      className={`group flex flex-col gap-3 rounded-none border border-[#e0ded5] bg-[#fffef8] p-4 shadow-[2px_2px_0_var(--paper-shadow)] transition-[border-color,transform] hover:border-[#d3d2c8] ${muted ? "opacity-60" : "hover:-translate-y-px"}`}
    >
      <div className="flex items-center gap-3">
        <Logo src={logo} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[#222320]">{name}</p>
          <div className="mt-1">{status}</div>
        </div>
      </div>
      <div className="flex-1 text-xs leading-relaxed text-[#6a6f63]">{children}</div>
      {action?.href ? (
        <a href={action.href} target="_blank" rel="noreferrer" className={`${ACTION_CLASS} self-start`}>
          {action.label}
        </a>
      ) : action ? (
        <button type="button" onClick={action.onClick} className={`${ACTION_CLASS} self-start`}>
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
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="text-[11px] font-mono font-semibold uppercase tracking-[0.12em] text-[#222320]">
          {title}
        </h3>
        <p className="text-xs text-[#6a6f63]">{hint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-none border border-[#e0ded5] bg-[#fffef8] px-4 py-3">
      <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-[#6a6f63]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#222320]">{value}</p>
    </div>
  );
}

function slackChip(slack: SetupStatus["slack"] | undefined): JSX.Element {
  if (!slack) return <ToneChip tone="neutral" label="Checking…" />;
  const configured = slack.signingSecret && slack.botToken && slack.approvers > 0;
  const partial =
    slack.signingSecret || slack.botToken || slack.approvers > 0 || slack.channelRepos;
  if (configured) return <ToneChip tone="ok" label="Connected" />;
  if (partial) return <ToneChip tone="pending" label="Partially set up" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

function githubChip(github: SetupStatus["github"] | undefined): JSX.Element {
  if (!github) return <ToneChip tone="neutral" label="Checking…" />;
  if (github.token && github.webhookSecret) return <ToneChip tone="ok" label="Connected" />;
  if (github.token || github.webhookSecret)
    return <ToneChip tone="pending" label="Partially set up" />;
  return <ToneChip tone="neutral" label="Not set up" />;
}

const COMING_SOON_APPS: { name: string; blurb: string }[] = [
  { name: "Notion", blurb: "Let your agents read and update your Notion workspace." },
  { name: "Linear", blurb: "Create and update Linear issues as your agents work." },
  { name: "Jira", blurb: "Link agent runs to Jira tickets and statuses." },
  { name: "Asana", blurb: "Turn agent output into Asana tasks and updates." },
];

export function IntegrationsView({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;

  const connected = status
    ? [
        status.github.token && status.github.webhookSecret,
        status.slack.signingSecret && status.slack.botToken && status.slack.approvers > 0,
        (mailboxList?.length ?? 0) > 0,
      ].filter(Boolean).length
    : 0;
  const needsSetup = status ? 3 - connected : 0;

  const failed = setup.state.kind === "error" ? setup.state : null;
  const reloadAll = () => {
    setup.reload();
    mailboxes.reload();
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Integrations</span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Third-party apps and channels your agents can reach — connect once, use everywhere.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-5xl mx-auto flex flex-col gap-8">
          {failed ? <LoadErrorState message={failed.message} onRetry={reloadAll} /> : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryTile label="Connected" value={status ? String(connected) : "…"} />
            <SummaryTile label="Needs setup" value={status ? String(needsSetup) : "…"} />
            <SummaryTile label="Coming soon" value={String(COMING_SOON_APPS.length)} />
          </div>

          <IntegrationGroup
            title="Apps"
            hint="OAuth apps your agents work with. AI-agent providers live in Agents & MCP."
          >
            <IntegrationCard
              name="GitHub"
              logo="/assets/channels/github.svg"
              status={githubChip(status?.github)}
              action={
                status && !(status.github.token && status.github.webhookSecret)
                  ? {
                      label: "Connect ↗",
                      href: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=shiba",
                    }
                  : undefined
              }
            >
              <p>Open pull requests and react to repo events on your behalf.</p>
              {status && !(status.github.token && status.github.webhookSecret) ? (
                <p className="mt-0.5 text-[11px]">
                  {status.github.token
                    ? "Token connected — add the webhook secret to finish setup."
                    : "Add a GitHub token and webhook secret in your deployment settings."}
                </p>
              ) : null}
            </IntegrationCard>
            {COMING_SOON_APPS.map((app) => (
              <IntegrationCard
                key={app.name}
                name={app.name}
                status={<ToneChip tone="neutral" label="Coming soon" />}
                muted
              >
                <p>{app.blurb}</p>
              </IntegrationCard>
            ))}
          </IntegrationGroup>

          <IntegrationGroup
            title="Chat & approval channels"
            hint="Chat apps where you can queue tasks and approve runs."
          >
            <IntegrationCard
              name="Slack"
              logo="/assets/channels/slack.svg"
              status={slackChip(status?.slack)}
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
            </IntegrationCard>
            <IntegrationCard
              name="Telegram"
              logo="/assets/channels/telegram.svg"
              status={<ToneChip tone="neutral" label="Available via deployment" />}
              action={{ label: "Open BotFather ↗", href: "https://t.me/BotFather" }}
            >
              <p>Send tasks and approvals through a Telegram bot.</p>
              <p className="mt-0.5 text-[11px]">
                Set up by your deployment operator — the dashboard can&apos;t verify it.
              </p>
            </IntegrationCard>
            <IntegrationCard
              name="Discord"
              logo="/assets/channels/discord.svg"
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
            </IntegrationCard>
          </IntegrationGroup>

          <IntegrationGroup title="Email" hint="Inbound triage and approval-gated outbound mail.">
            <IntegrationCard
              name="Mailbox"
              status={
                mailboxList === undefined ? (
                  <ToneChip
                    tone="neutral"
                    label={mailboxes.state.kind === "error" ? "Status error" : "Checking…"}
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
            </IntegrationCard>
          </IntegrationGroup>
        </div>
      </div>
    </div>
  );
}
