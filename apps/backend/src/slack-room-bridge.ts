/** Narrow Slack Events API adapter for owner-mapped collaboration room threads. */
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import {
  ingestCollaborationSlackMessage,
  observeCollaborationSlackThread,
} from "./collaboration-store.js";
import type { SlackEventCallbackBody } from "./slack-events.js";
import { resolveThreadTs } from "./slack-thread.js";

interface SlackRoomMessageEvent {
  type?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  channel?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
}

function slackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Called only from Slack Events API's post-signature onEvent callback. */
export async function handleSlackRoomEvent(body: SlackEventCallbackBody, env: Env): Promise<void> {
  if (!env.AGENT_AUDIT || !slackId(body.event_id) || !slackId(body.team_id)) return;
  const event = body.event as SlackRoomMessageEvent | undefined;
  if (!event || (event.type !== "app_mention" && event.type !== "message")) return;
  if (typeof event.subtype === "string" || typeof event.bot_id === "string") return;
  if (!slackId(event.channel) || !slackId(event.user) || typeof event.text !== "string") return;
  // Only app mentions can establish a root thread. Ordinary message events
  // enter the room only as replies to that already-observed root.
  if (event.type === "message" && typeof event.thread_ts !== "string") return;
  const threadTs = resolveThreadTs({
    ...(typeof event.thread_ts === "string" ? { thread_ts: event.thread_ts } : {}),
    ...(typeof event.ts === "string" ? { ts: event.ts } : {}),
  });
  if (!threadTs) return;
  const createdAt = Date.now();
  try {
    await observeCollaborationSlackThread(env, {
      teamId: body.team_id,
      channelId: event.channel,
      threadTs,
      eventId: body.event_id,
      userId: event.user,
      seenAt: createdAt,
    });
    await ingestCollaborationSlackMessage(env, {
      eventId: body.event_id,
      teamId: body.team_id,
      channelId: event.channel,
      threadTs,
      userId: event.user,
      text: event.text,
      createdAt,
    });
  } catch (error) {
    console.error("Slack room bridge ingestion failed", redactSecrets(String(error)));
  }
}
