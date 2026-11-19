import { createSlackAdapter } from "./channels/slack/index.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { postSlackMessage, SlackPostRejectedError, verifySlackBotInstallation } from "./slack.js";
import type { SlackPersonaRole } from "./slack-persona.js";
import type { parseSlackThreadName } from "./slack-thread.js";

export const SEND_SLACK_REPLY_ACTION = "shiba_send_external_reply";
const DRAFT_TTL_MS = 60 * 60 * 1000;
type Destination = NonNullable<ReturnType<typeof parseSlackThreadName>>;
type SlackEnv = Pick<Env, "AGENT_AUDIT" | "SLACK_BOT_TOKEN" | "SLACK_APPROVERS">;
const plain = (text: string) => ({ type: "plain_text", text });

function reviewers(env: SlackEnv): string[] {
  return (env.SLACK_APPROVERS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

export async function slackChannelAudience(token: string, channelId: string) {
  return createSlackAdapter({ token }).audience(channelId).catch(() => "unknown" as const);
}

export async function deliverSlackThreadReply(
  env: SlackEnv, destination: Destination, sourceId: string,
  input: { text: string; blocks?: unknown[]; persona?: SlackPersonaRole },
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) return;
  const adapter = createSlackAdapter({ token });
  const { teamId, channelId, threadTs } = destination;
  const audience = await slackChannelAudience(token, channelId);
  if (audience === "unknown") throw new Error("Slack channel audience is unavailable.");
  if (audience === "internal") {
    await postSlackMessage(token, { ...input, channel: channelId, threadTs });
    return;
  }

  const eligible = reviewers(env);
  if (!eligible.length || (await verifySlackBotInstallation(token)).teamId !== teamId)
    throw new Error("No internal Slack reviewer is configured.");
  const membership = await Promise.all(eligible.map((id) => adapter.isInternalUser(teamId, id).catch(() => false)));
  const reviewer = eligible.find((_, i) => membership[i]);
  if (!reviewer) throw new Error("No authorized internal Slack reviewer is available.");
  if (input.blocks?.length) {
    await adapter.postPrivate({ placeId: channelId, threadId: threadTs, userId: reviewer, text: input.text, blocks: input.blocks });
    return;
  }

  const body = redactSecrets(input.text).trim().slice(0, 3000);
  if (!body) return;
  const dm = await adapter.openDirect(reviewer);
  if (dm === channelId) throw new Error("Slack review must use a separate direct conversation.");
  const id = crypto.randomUUID();
  const created = await env.AGENT_AUDIT.prepare(
    `INSERT INTO slack_reply_drafts(id, team_id, channel_id, thread_ts, source_id, reviewer_id, review_dm, body, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(team_id, channel_id, thread_ts, source_id) DO NOTHING RETURNING id`,
  ).bind(id, teamId, channelId, threadTs, sourceId, reviewer, dm, body, Date.now() + DRAFT_TTL_MS).first();
  if (!created) return;
  await adapter.post({ placeId: dm, text: "Review a Shiba reply to an external Slack channel", native: {
    blocks: [
      { type: "section", text: plain(`Review this reply before sending it to external Slack channel ${channelId}, thread ${threadTs}. This draft expires in one hour.`) },
      { type: "section", text: plain(body) },
      { type: "actions", elements: [{ type: "button", action_id: SEND_SLACK_REPLY_ACTION, value: id, text: plain("Send to external channel") }] },
    ],
  } });
}

export async function sendReviewedSlackReply(
  env: SlackEnv, input: { id: string; teamId: string; dm: string; userId: string },
): Promise<string> {
  const unavailable = "This draft is unavailable or was already handled. No new message was sent.";
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token || !reviewers(env).includes(input.userId) || !/^[a-f0-9-]{36}$/.test(input.id)) return unavailable;
  const args = [input.id, input.teamId, input.dm, input.userId] as const;
  const match = "id=? AND team_id=? AND review_dm=? AND reviewer_id=? AND status='draft' AND expires_at>?";
  const draft = await env.AGENT_AUDIT.prepare(`SELECT channel_id FROM slack_reply_drafts WHERE ${match}`)
    .bind(...args, Date.now()).first<{ channel_id: string }>();
  if (!draft) return unavailable;
  const adapter = createSlackAdapter({ token });
  if ((await verifySlackBotInstallation(token)).teamId !== input.teamId ||
    !await adapter.isInternalUser(input.teamId, input.userId) ||
    await slackChannelAudience(token, draft.channel_id) !== "external") return unavailable;
  const now = Date.now();
  const claimed = await env.AGENT_AUDIT.prepare(
    `UPDATE slack_reply_drafts SET status='sending', approved_at=? WHERE ${match} RETURNING channel_id, thread_ts, body`,
  ).bind(now, ...args, now).first<{ channel_id: string; thread_ts: string; body: string }>();
  if (!claimed) return unavailable;

  let status = "unknown", receiptTs: string | null = null;
  try {
    const receipt = await adapter.post({
      placeId: claimed.channel_id, threadId: claimed.thread_ts, text: claimed.body,
      native: { mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false, client_msg_id: input.id },
    });
    if (receipt.placeId === claimed.channel_id) {
      status = "sent";
      receiptTs = receipt.messageId;
    }
  } catch (error) {
    if (error instanceof SlackPostRejectedError && error.outcomeKnown) status = "failed";
  }
  const saved = await env.AGENT_AUDIT.prepare("UPDATE slack_reply_drafts SET status=?, receipt_ts=? WHERE id=? AND status='sending'")
    .bind(status, receiptTs, input.id).run();
  if (saved.meta.changes !== 1) throw new Error("Slack reply outcome was not recorded.");
  return status === "sent" ? "Reply sent to the external channel." : status === "failed"
    ? "Slack rejected the reply. It will not be retried."
    : "Slack delivery could not be confirmed. Check the thread; no automatic retry will run.";
}
