/**
 * Slack channel: Web API adapter and Events/Interactivity transport.
 *
 * Slack signs every request with HMAC-SHA256 over `v0:{timestamp}:{body}`
 * and SLACK_SIGNING_SECRET; verifySlackRequest also enforces the five
 * minute replay window. The conversation key names the thread, so every
 * reply in one Slack thread lands in the same orchestrator.
 */
import type { Env } from "../../env.js";
import { postSlackMessageWithReceipt, SLACK_POST_TIMEOUT_MS, updateSlackMessage, verifySlackRequest } from "../../slack.js";
import { reactionName } from "../emoji.js";
import { buildSlackThreadName } from "../../slack-thread.js";
import {
  dedupeIds,
  type ChannelAdapter,
  type ChannelAdapterOptions,
  type ChannelCapability,
  type ChannelDefinition,
  type ChannelHistoryMessage,
  type ChannelTransport,
  type InboundEvent,
} from "../../ports/channel/index.js";
import { asString, channelFetch, readFile, readJsonObject } from "../http.js";

export const SLACK_API = "https://slack.com/api";

const CAPABILITIES: ReadonlySet<ChannelCapability> = new Set<ChannelCapability>([
  "post", "edit", "react", "upload", "download", "history", "recent", "authorName", "placeName",
]);

export function slackMentions(text: string): string[] {
  return dedupeIds([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi)].map((m) => m[1] ?? ""));
}

function toHistory(messages: unknown, threadId?: string): ChannelHistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ChannelHistoryMessage[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as { ts?: unknown; user?: unknown; bot_id?: unknown; text?: unknown; thread_ts?: unknown };
    if (typeof m.ts !== "string") continue;
    const thread = threadId ?? (typeof m.thread_ts === "string" ? m.thread_ts : undefined);
    out.push({
      messageId: m.ts,
      authorId: asString(m.user) || asString(m.bot_id),
      text: asString(m.text),
      isBot: typeof m.bot_id === "string",
      ...(thread ? { threadId: thread } : {}),
    });
  }
  return out;
}

export function createSlackAdapter(input: { token: string; fetch?: typeof fetch }): ChannelAdapter {
  const fetchImpl = input.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${input.token}` };
  const ok = async (method: string, response: Response) => {
    const json = await readJsonObject(response);
    // Slack answers HTTP 200 with {ok:false, error} — check both.
    if (!response.ok || json.ok !== true) {
      throw new Error(`Slack ${method} failed: ${typeof json.error === "string" ? json.error : `Slack API ${response.status}`}`);
    }
    return json;
  };
  const get = async (method: string, params: Record<string, string>) =>
    ok(method, await channelFetch(fetchImpl, `Slack ${method}`, `${SLACK_API}/${method}?${new URLSearchParams(params)}`, {
      method: "GET",
      headers: auth,
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    }));
  const post = async (method: string, body: Record<string, unknown>) =>
    ok(method, await channelFetch(fetchImpl, `Slack ${method}`, `${SLACK_API}/${method}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    }));
  const limit = (n: number | undefined) => String(Math.min(Math.max(Math.trunc(n ?? 50), 1), 200));
  return {
    channel: "slack",
    capabilities: CAPABILITIES,
    async post(message) {
      const receipt = await postSlackMessageWithReceipt(input.token, {
        channel: message.placeId,
        ...(message.threadId ? { threadTs: message.threadId } : {}),
        text: message.text,
        ...(message.native ? { native: message.native } : {}),
      }, fetchImpl);
      return { placeId: receipt.channel, messageId: receipt.ts, ...(message.threadId ? { threadId: message.threadId } : {}) };
    },
    async edit(edit) {
      await updateSlackMessage(input.token, {
        channel: edit.ref.placeId,
        ts: edit.ref.messageId,
        text: edit.text,
        ...(edit.native ? { native: edit.native } : {}),
      }, fetchImpl);
    },
    async react(ref, emoji) {
      await post("reactions.add", { channel: ref.placeId, timestamp: ref.messageId, name: reactionName(emoji) });
    },
    async upload(upload) {
      const slot = await get("files.getUploadURLExternal", { filename: upload.filename, length: String(upload.data.byteLength) });
      const uploadUrl = asString(slot.upload_url);
      const fileId = asString(slot.file_id);
      if (!uploadUrl.startsWith("https://") || !fileId) throw new Error("Slack files.getUploadURLExternal returned no upload slot.");
      const sent = await channelFetch(fetchImpl, "Slack file upload", uploadUrl, {
        method: "POST",
        headers: { "Content-Type": upload.contentType },
        body: upload.data,
      });
      if (!sent.ok) throw new Error(`Slack file upload failed (${sent.status}).`);
      await post("files.completeUploadExternal", {
        files: [{ id: fileId, title: upload.filename }],
        channel_id: upload.placeId,
        ...(upload.threadId ? { thread_ts: upload.threadId } : {}),
        ...(upload.comment ? { initial_comment: upload.comment } : {}),
      });
      return { placeId: upload.placeId, messageId: fileId, ...(upload.threadId ? { threadId: upload.threadId } : {}) };
    },
    async download(url) {
      // url_private needs the bot token; never send it to any other host.
      if (!/^https:\/\/files\.slack\.com\//.test(url)) throw new Error("Slack download only fetches files.slack.com URLs.");
      return readFile(await channelFetch(fetchImpl, "Slack file download", url, { method: "GET", headers: auth }), "Slack file download");
    },
    async history(placeId, threadId, max) {
      return toHistory((await get("conversations.replies", { channel: placeId, ts: threadId, limit: limit(max) })).messages, threadId);
    },
    async recent(placeId, max) {
      return toHistory((await get("conversations.history", { channel: placeId, limit: limit(max) })).messages).reverse();
    },
    async authorName(userId) {
      const user = (await get("users.info", { user: userId })).user as Record<string, unknown> | undefined;
      const profile = user?.profile as Record<string, unknown> | undefined;
      return asString(profile?.display_name) || asString(profile?.real_name) || asString(user?.name) || userId;
    },
    async placeName(placeId) {
      const channel = (await get("conversations.info", { channel: placeId })).channel as Record<string, unknown> | undefined;
      const name = asString(channel?.name);
      return name ? `#${name}` : placeId;
    },
    mentions: slackMentions,
  };
}

function threadKey(teamId: string, channelId: string, threadTs: string): string {
  try {
    return buildSlackThreadName(teamId, channelId, threadTs);
  } catch {
    return "";
  }
}

interface SlackEventEnvelope {
  type?: unknown;
  event_id?: unknown;
  team_id?: unknown;
  event?: {
    type?: unknown;
    user?: unknown;
    bot_id?: unknown;
    text?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    channel?: unknown;
    channel_type?: unknown;
  };
}

function parseEventCallback(rawBody: string): InboundEvent | null {
  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || body.type !== "event_callback") return null;
  const event = body.event;
  if (!event || (event.type !== "app_mention" && event.type !== "message")) return null;
  const teamId = asString(body.team_id);
  const placeId = asString(event.channel);
  const messageId = asString(event.ts);
  const threadTs = asString(event.thread_ts);
  const text = asString(event.text);
  return {
    kind: "message",
    channel: "slack",
    deliveryId: asString(body.event_id),
    conversationKey: threadKey(teamId, placeId, threadTs || messageId),
    placeId,
    ...(teamId ? { workspaceId: teamId } : {}),
    messageId,
    ...(threadTs ? { threadId: threadTs } : {}),
    authorId: asString(event.user) || asString(event.bot_id),
    text,
    mentionedUserIds: slackMentions(text),
    isDirect: event.channel_type === "im",
    isBot: typeof event.bot_id === "string",
    raw: body,
  };
}

function parseForm(rawBody: string): InboundEvent | null {
  const params = new URLSearchParams(rawBody);
  const payloadParam = params.get("payload");
  if (payloadParam !== null) {
    let payload: {
      type?: unknown;
      trigger_id?: unknown;
      team?: { id?: unknown };
      user?: { id?: unknown; username?: unknown; name?: unknown };
      channel?: { id?: unknown };
      container?: { channel_id?: unknown; message_ts?: unknown; thread_ts?: unknown };
      message?: { ts?: unknown; thread_ts?: unknown; text?: unknown };
      actions?: Array<{ action_id?: unknown; value?: unknown }>;
    };
    try {
      payload = JSON.parse(payloadParam) as typeof payload;
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null || payload.type !== "block_actions") return null;
    const action = payload.actions?.[0];
    if (!action) return null;
    const teamId = asString(payload.team?.id);
    const placeId = asString(payload.channel?.id) || asString(payload.container?.channel_id);
    const messageId = asString(payload.container?.message_ts) || asString(payload.message?.ts);
    const threadTs = asString(payload.message?.thread_ts) || asString(payload.container?.thread_ts);
    const actorName = asString(payload.user?.username) || asString(payload.user?.name);
    return {
      kind: "action",
      channel: "slack",
      deliveryId: asString(payload.trigger_id),
      conversationKey: threadKey(teamId, placeId, threadTs || messageId),
      placeId,
      ...(teamId ? { workspaceId: teamId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(typeof payload.message?.text === "string" ? { messageText: payload.message.text } : {}),
      actorId: asString(payload.user?.id),
      ...(actorName ? { actorName } : {}),
      actionId: asString(action.action_id),
      value: asString(action.value),
      raw: payload,
    };
  }
  const command = params.get("command");
  if (command === null) return null;
  const text = params.get("text") ?? "";
  const placeId = params.get("channel_id") ?? "";
  const userName = params.get("user_name") ?? "";
  const teamId = params.get("team_id") ?? "";
  return {
    kind: "message",
    channel: "slack",
    deliveryId: params.get("trigger_id") ?? "",
    // A slash command is not in a thread yet; its approval card starts one.
    conversationKey: "",
    placeId,
    ...(teamId ? { workspaceId: teamId } : {}),
    messageId: "",
    authorId: params.get("user_id") ?? "",
    ...(userName ? { authorName: userName } : {}),
    text,
    mentionedUserIds: slackMentions(text),
    isDirect: placeId.startsWith("D"),
    isBot: false,
    command: { name: command.trim().replace(/^\//, ""), options: { text } },
    raw: Object.fromEntries(params),
  };
}

export const slackTransport: ChannelTransport = {
  channel: "slack",
  async verify(rawBody, headers, env, now) {
    const secret = env.SLACK_SIGNING_SECRET ?? "";
    if (!secret) {
      console.warn("Webhook disabled: SLACK_SIGNING_SECRET is unset.");
      return { ok: false, status: 503, error: "Webhook is disabled." };
    }
    if (!(await verifySlackRequest(rawBody, headers, secret, now))) {
      return { ok: false, status: 401, error: "Invalid Slack signature." };
    }
    return { ok: true };
  },
  parse(rawBody) {
    return rawBody.trimStart().startsWith("{") ? parseEventCallback(rawBody) : parseForm(rawBody);
  },
  conversationKey(event) {
    if (event.conversationKey) return event.conversationKey;
    const threadTs = event.kind === "message" ? event.threadId ?? event.messageId : event.messageId ?? "";
    return threadKey(event.workspaceId ?? "", event.placeId, threadTs);
  },
};

export const slackChannel: ChannelDefinition = {
  id: "slack",
  requiredSecrets: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"],
  transport: slackTransport,
  createAdapter(env: Env, options: ChannelAdapterOptions = {}) {
    const token = env.SLACK_BOT_TOKEN?.trim();
    return token ? createSlackAdapter({ token, ...(options.fetch ? { fetch: options.fetch } : {}) }) : null;
  },
};
