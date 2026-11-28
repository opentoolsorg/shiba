/**
 * Preview-first replies for Slack channels shared outside the workspace.
 *
 * Slack proves a delivery came from Slack; it proves nothing about who can
 * read the channel. An externally shared channel (Slack Connect) carries every
 * reply into another organization, so this module holds those replies instead:
 * the exact text goes to one authorized internal reviewer as a Slack DM, and
 * only that reviewer's signed click sends it. Internal channels post as
 * before; a channel whose audience cannot be verified posts nothing.
 */
import { createSlackAdapter } from "./channels/slack/index.js";
import type { Env } from "./env.js";
import { log } from "./obs/log.js";
import { redactSecrets } from "./security.js";
import { parseApproverAllowlist } from "./slack-approvers.js";
import type { SlackPersonaRole } from "./slack-persona.js";
import { SlackPostRejectedError, verifySlackBotInstallation } from "./slack.js";
import type { SlackThreadIds } from "./slack-thread.js";

export const SEND_SLACK_REPLY_ACTION = "shiba_send_external_reply";

/** A reviewed draft is never sendable after an hour, whatever its author intends. */
const DRAFT_TTL_MS = 60 * 60 * 1000;
const UNAVAILABLE = "This draft is unavailable or was already handled. No new message was sent.";

type ReplyEnv = Pick<Env, "AGENT_AUDIT" | "SLACK_BOT_TOKEN" | "SLACK_APPROVERS">;
type ReplyInput = { text: string; native?: Record<string, unknown>; persona?: SlackPersonaRole };

const plain = (text: string) => ({ type: "plain_text", text });

function slack(env: ReplyEnv) {
  const token = env.SLACK_BOT_TOKEN?.trim();
  return token ? { token, adapter: createSlackAdapter({ token }) } : null;
}

/** `unknown` covers a missing scope or an inconsistent payload: both fail closed. */
export async function slackChannelAudience(token: string, channelId: string) {
  return createSlackAdapter({ token }).audience(channelId).catch(() => "unknown" as const);
}

/** The first allowlisted approver who is a live member of this workspace. */
async function approvedReviewer(env: ReplyEnv, token: string, teamId: string) {
  const adapter = createSlackAdapter({ token });
  for (const userId of parseApproverAllowlist(env.SLACK_APPROVERS)) {
    if (await adapter.isInternalUser(teamId, userId).catch(() => false)) return { userId, adapter };
  }
  return null;
}

/**
 * Deliver one reply to a Slack thread. Internal channels post as before; a
 * channel shared outside the workspace gets a DM-held draft instead, and an
 * unverifiable channel posts nothing at all.
 */
export async function deliverSlackThreadReply(
  env: ReplyEnv,
  destination: SlackThreadIds,
  sourceId: string,
  input: ReplyInput,
): Promise<void> {
  const client = slack(env);
  if (!client) return;
  const { teamId, channelId, threadTs } = destination;
  const audience = await client.adapter.audience(channelId).catch(() => "unknown" as const);
  if (audience === "internal") {
    await client.adapter.post({
      placeId: channelId,
      threadId: threadTs,
      text: input.text,
      ...(input.native ? { native: input.native } : {}),
      ...(input.persona ? { persona: input.persona } : {}),
    });
    return;
  }
  if ((await verifySlackBotInstallation(client.token)).teamId !== teamId)
    throw new Error("The Slack bot token belongs to another workspace.");
  const reviewer = await approvedReviewer(env, client.token, teamId);
  if (!reviewer) throw new Error("No internal reviewer can be verified for this Slack workspace.");
  const dm = await reviewer.adapter.openDirect(reviewer.userId);
  if (dm === channelId) throw new Error("A Slack review must be a separate direct conversation.");

  if (audience === "unknown") {
    await reviewer.adapter.post({
      placeId: dm,
      text: `Shiba is holding a reply to channel ${channelId} (thread ${threadTs}) because it cannot verify whether that channel is shared outside this workspace. Add the channels:read and groups:read bot scopes, reinstall the app, then run the request again.`,
    }).catch((error: unknown) => log.error("Slack audience notice failed", redactSecrets(String(error))));
    return;
  }

  // Cards carry frozen task text and approve an action, so they stay private to
  // the reviewer. They never become a channel post and never share a reply
  // draft's send button.
  if (input.native) {
    if (!Array.isArray(input.native.blocks) || input.native.blocks.length === 0)
      throw new Error("An external Slack card has no blocks to deliver privately.");
    await reviewer.adapter.post({
      placeId: dm,
      text: input.text,
      native: input.native,
      ...(input.persona ? { persona: input.persona } : {}),
    });
    return;
  }

  const body = redactSecrets(input.text).trim().slice(0, 3000);
  if (!body) return;
  const draftId = crypto.randomUUID();
  const created = await env.AGENT_AUDIT.prepare(
    `INSERT INTO slack_reply_drafts(id,team_id,channel_id,thread_ts,source_id,reviewer_id,review_dm,body,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(team_id,channel_id,thread_ts,source_id) DO NOTHING RETURNING id`,
  ).bind(draftId, teamId, channelId, threadTs, sourceId, reviewer.userId, dm, body, Date.now() + DRAFT_TTL_MS).first();
  // One source event owns one draft: a replayed delivery or outbox retry must
  // not mint a second reviewer prompt for the same reply.
  if (!created) return;
  await reviewer.adapter.post({
    placeId: dm,
    text: `Review a reply to external Slack channel ${channelId}`,
    native: {
      blocks: [
        { type: "section", text: plain(`Review this reply before Shiba posts it to channel ${channelId}, which is shared outside this workspace. Thread ${threadTs}. The draft expires in one hour.`) },
        { type: "section", text: plain(body) },
        { type: "actions", elements: [{ type: "button", action_id: SEND_SLACK_REPLY_ACTION, value: draftId, text: plain("Send to external channel") }] },
      ],
    },
  });
}

/**
 * Send one reviewed draft. A click authenticates Slack, not the human: the
 * reviewer's Slack identity is re-read and the draft is claimed durably before
 * the write, so a duplicate callback can never post twice.
 */
export async function sendReviewedSlackReply(
  env: ReplyEnv,
  input: { id: string; teamId: string; dm: string; userId: string },
): Promise<string> {
  const client = slack(env);
  if (!client || !parseApproverAllowlist(env.SLACK_APPROVERS).includes(input.userId) || !/^[a-f0-9-]{36}$/.test(input.id))
    return UNAVAILABLE;
  const guard = "id=? AND team_id=? AND review_dm=? AND reviewer_id=? AND status='draft' AND expires_at>?";
  const args = [input.id, input.teamId, input.dm, input.userId] as const;
  const draft = await env.AGENT_AUDIT.prepare(`SELECT channel_id FROM slack_reply_drafts WHERE ${guard}`)
    .bind(...args, Date.now()).first<{ channel_id: string }>();
  if (!draft) return UNAVAILABLE;
  if ((await verifySlackBotInstallation(client.token)).teamId !== input.teamId ||
    !await client.adapter.isInternalUser(input.teamId, input.userId).catch(() => false) ||
    await client.adapter.audience(draft.channel_id).catch(() => "unknown") !== "external") return UNAVAILABLE;

  const now = Date.now();
  const claimed = await env.AGENT_AUDIT.prepare(
    `UPDATE slack_reply_drafts SET status='sending',approved_at=? WHERE ${guard} RETURNING channel_id,thread_ts,body`,
  ).bind(now, ...args, now).first<{ channel_id: string; thread_ts: string; body: string }>();
  if (!claimed) return UNAVAILABLE;

  let status = "unknown";
  let receiptTs: string | null = null;
  try {
    const receipt = await client.adapter.post({
      placeId: claimed.channel_id,
      threadId: claimed.thread_ts,
      text: claimed.body,
      // The reviewed text stays literal: no markdown, mentions, or link previews
      // appear after the reviewer approved it.
      native: { mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false, client_msg_id: input.id },
    });
    if (receipt.placeId === claimed.channel_id) {
      status = "sent";
      receiptTs = receipt.messageId;
    }
  } catch (error) {
    if (error instanceof SlackPostRejectedError && error.outcomeKnown) status = "failed";
    else log.error("Reviewed Slack reply delivery is unconfirmed", redactSecrets(String(error)));
  }
  const saved = await env.AGENT_AUDIT.prepare("UPDATE slack_reply_drafts SET status=?,receipt_ts=? WHERE id=? AND status='sending'")
    .bind(status, receiptTs, input.id).run();
  if (saved.meta.changes !== 1) throw new Error("The reviewed Slack reply outcome was not recorded.");
  return status === "sent" ? "Reply sent to the external channel."
    : status === "failed" ? "Slack rejected the reply. It will not be retried."
      : "Slack delivery could not be confirmed. Check the thread; no automatic retry will run.";
}
