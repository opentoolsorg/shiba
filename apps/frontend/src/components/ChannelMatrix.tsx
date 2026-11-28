/**
 * ChannelMatrix — the honest omnichannel capability and setup matrix for
 * Slack, Discord, Teams, Telegram, and the planned Gmail / iOS surfaces.
 *
 * Every capability cell reflects what the backend channel adapters actually
 * implement today (see `apps/backend/src/channels/*`): a "No" here is a real
 * limitation, not a missing toggle. The connection column only says "Live"
 * when a real API read in this deployment reported a connection; otherwise
 * it says the state is unverified — no fake live claims.
 */
import type { JSX } from "react";
import { ToneChip, type ChipTone } from "./ToneChip";

export type ChannelSurfaceId = "slack" | "discord" | "teams" | "telegram" | "gmail" | "ios";

/** Live connection read for a surface, when the dashboard has a real API for it. */
export type ChannelConnectionState = "connected" | "disconnected" | "checking" | "unknown";

export type ChannelCapabilityState = "yes" | "no" | "partial" | "elsewhere";

export interface ChannelCapabilityCell {
  state: ChannelCapabilityState;
  /** Short cell label, e.g. "Yes" or "Email fallback". */
  label: string;
  /** One honest sentence explaining the cell, rendered under the label. */
  detail: string;
}

export interface ChannelMatrixEntry {
  id: ChannelSurfaceId;
  name: string;
  implementation: "implemented" | "partial" | "planned";
  implementationNote: string;
  approvals: ChannelCapabilityCell;
  publication: ChannelCapabilityCell;
  history: ChannelCapabilityCell;
  uploads: ChannelCapabilityCell;
  setupHref: string;
  setupLabel: string;
}

const yes = (detail: string): ChannelCapabilityCell => ({ state: "yes", label: "Yes", detail });
const no = (label: string, detail: string): ChannelCapabilityCell => ({ state: "no", label, detail });

/**
 * Static capability facts mirrored from the backend channel adapters.
 * When a backend lane gains or loses a capability, update the matching cell
 * here in the same change — this table is a user-facing promise.
 */
export const CHANNEL_CAPABILITY_MATRIX: readonly ChannelMatrixEntry[] = [
  {
    id: "slack",
    name: "Slack",
    implementation: "implemented",
    implementationNote: "Full chat lane: queue tasks, approve runs, receive results in-thread.",
    approvals: yes("Approve/Reject buttons post in-channel; only allow-listed approvers can press them."),
    publication: yes("The second pull-request publication approval posts into the originating channel."),
    history: yes("Channel and thread history through conversations.history."),
    uploads: yes("File uploads through files.getUploadURLExternal."),
    setupHref: "/docs/slack-setup/",
    setupLabel: "Slack setup guide",
  },
  {
    id: "discord",
    name: "Discord",
    implementation: "implemented",
    implementationNote: "Full chat lane: slash commands, mentions, approvals, and results.",
    approvals: yes("Approve/Reject buttons on the interaction card; only allow-listed approvers can press them."),
    publication: yes("The second pull-request publication approval posts into the originating channel."),
    history: yes("Thread-scoped message history."),
    uploads: yes("File attachments on channel and thread messages."),
    setupHref: "/docs/discord-setup/",
    setupLabel: "Discord setup guide",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    implementation: "implemented",
    implementationNote: "Chat lane over the Bot Framework Connector: queue tasks and approve runs.",
    approvals: yes("Adaptive-card Approve/Reject buttons; only allow-listed approvers can press them."),
    publication: yes("The second pull-request publication approval posts into the originating conversation."),
    history: no("No", "The Bot Framework Connector exposes no message-history API."),
    uploads: no("No", "File consent and Graph uploads are not part of the Connector lane."),
    setupHref: "/docs/teams-setup/",
    setupLabel: "Teams setup guide",
  },
  {
    id: "telegram",
    name: "Telegram",
    implementation: "implemented",
    implementationNote: "Chat lane through a Telegram bot: /shiba queues an approval-gated task.",
    approvals: yes("Inline-keyboard Approve/Reject buttons; only TELEGRAM_APPROVERS user ids can press them."),
    publication: { state: "elsewhere", label: "Email / dashboard", detail: "Publication approvals do not post into Telegram; they fall back to email or the dashboard." },
    history: no("No", "The Telegram Bot API has no message history, so history reads are unsupported."),
    uploads: yes("Document uploads with captions."),
    setupHref: "/docs/telegram-setup/",
    setupLabel: "Telegram setup guide",
  },
  {
    id: "gmail",
    name: "Gmail / email",
    implementation: "partial",
    implementationNote: "Inbound email is a task front door and replies are post-only. A full Gmail chat surface is planned.",
    approvals: no("No", "Email is spoofable, so nothing a sender writes can decide an approval; approvals stay in the dashboard and chat channels."),
    publication: no("No", "Publication approvals are never decided over email."),
    history: no("No", "The email transport is post-only."),
    uploads: no("No", "The email transport does not upload files."),
    setupHref: "/docs/email/",
    setupLabel: "Email setup guide",
  },
  {
    id: "ios",
    name: "iOS (Apple Shortcut)",
    implementation: "partial",
    implementationNote: "The /api/trigger lane queues approval-gated tasks from an Apple Shortcut. A native iOS app is planned.",
    approvals: { state: "partial", label: "Queue only", detail: "A Shortcut can only queue work; the approval itself is always decided on the dashboard." },
    publication: no("No", "Publication approvals resolve on the dashboard, not on the phone."),
    history: no("No", "The trigger lane is fire-and-forget; it reads nothing back."),
    uploads: no("No", "The trigger lane accepts a JSON task payload only."),
    setupHref: "/docs/triggers/",
    setupLabel: "Trigger setup guide",
  },
];

const CAPABILITY_TONE: Record<ChannelCapabilityState, ChipTone> = {
  yes: "ok",
  no: "neutral",
  partial: "pending",
  elsewhere: "navy",
};

const IMPLEMENTATION_CHIP: Record<ChannelMatrixEntry["implementation"], { tone: ChipTone; label: string }> = {
  implemented: { tone: "navy", label: "Implemented" },
  partial: { tone: "pending", label: "Partially implemented" },
  planned: { tone: "neutral", label: "Planned" },
};

function connectionChip(state: ChannelConnectionState | undefined): { tone: ChipTone; label: string } {
  switch (state) {
    case "connected":
      return { tone: "ok", label: "Live" };
    case "disconnected":
      return { tone: "neutral", label: "Not connected" };
    case "checking":
      return { tone: "neutral", label: "Checking…" };
    default:
      return { tone: "neutral", label: "Not verified here" };
  }
}

function CapabilityCellView({ cell }: { cell: ChannelCapabilityCell }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <ToneChip tone={CAPABILITY_TONE[cell.state]} label={cell.label} />
      <span className="text-[11px] leading-snug text-[var(--muted-foreground-2)]">{cell.detail}</span>
    </div>
  );
}

export function ChannelMatrix({
  live,
}: {
  /** Per-surface live connection reads, where the dashboard has a real API for them. */
  live?: Partial<Record<ChannelSurfaceId, ChannelConnectionState>>;
}): JSX.Element {
  return (
    <section
      aria-labelledby="channel-matrix-heading"
      data-testid="channel-matrix"
      className="rounded-[var(--radius-card)] border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)] sm:p-5"
    >
      <h2 id="channel-matrix-heading" className="text-base font-semibold text-[var(--fg)]">
        Channel capability matrix
      </h2>
      <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-[var(--muted-foreground-2)]">
        What each omnichannel surface can actually do today. Every run stays approval-gated: a connected channel can queue work,
        but nothing executes until a human approves it. A surface only shows <span className="font-medium text-[var(--fg)]">Live</span> when
        this deployment reported a real connection.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--border-1)]">
              {["Surface", "Connection", "Approvals", "PR publication", "History", "Uploads", "Setup"].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="px-3 py-2 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CHANNEL_CAPABILITY_MATRIX.map((entry) => {
              const implementation = IMPLEMENTATION_CHIP[entry.implementation];
              const connection = entry.implementation === "planned" ? null : connectionChip(live?.[entry.id]);
              return (
                <tr key={entry.id} data-testid={`channel-matrix-row-${entry.id}`} className="border-b border-[var(--border-1)] align-top last:border-b-0">
                  <th scope="row" className="px-3 py-3 font-normal">
                    <div className="flex flex-col gap-1">
                      <span className="text-[13px] font-semibold text-[var(--fg)]">{entry.name}</span>
                      <ToneChip tone={implementation.tone} label={implementation.label} />
                      <span className="max-w-[220px] text-[11px] leading-snug text-[var(--muted-foreground-2)]">{entry.implementationNote}</span>
                    </div>
                  </th>
                  <td className="px-3 py-3">
                    {connection ? <ToneChip tone={connection.tone} label={connection.label} /> : <span className="text-[11px] text-[var(--muted-foreground-2)]">—</span>}
                  </td>
                  <td className="max-w-[200px] px-3 py-3"><CapabilityCellView cell={entry.approvals} /></td>
                  <td className="max-w-[200px] px-3 py-3"><CapabilityCellView cell={entry.publication} /></td>
                  <td className="max-w-[200px] px-3 py-3"><CapabilityCellView cell={entry.history} /></td>
                  <td className="max-w-[200px] px-3 py-3"><CapabilityCellView cell={entry.uploads} /></td>
                  <td className="px-3 py-3">
                    <a
                      href={entry.setupHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 sm:min-h-8"
                    >
                      {entry.setupLabel} ↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
