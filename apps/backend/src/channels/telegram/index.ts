/**
 * Telegram channel: Bot API adapter and webhook transport.
 *
 * Telegram signs nothing; setWebhook's secret_token is echoed in
 * X-Telegram-Bot-Api-Secret-Token on every delivery, so that header is the
 * authentication. The Bot API has no message history, so history and
 * recent are unsupported.
 */
import { buildChatThreadName } from "@shiba/shared";
import type { Env } from "../../env.js";
import { reactionGlyph } from "../emoji.js";
import { timingSafeEqual } from "../../slack.js";
import {
  ChannelUnsupportedError,
  dedupeIds,
  type ChannelAdapter,
  type ChannelAdapterOptions,
  type ChannelCapability,
  type ChannelDefinition,
  type ChannelMessageRef,
  type ChannelTransport,
  type InboundEvent,
} from "../../ports/channel/index.js";
import { asString, channelFetch, readFile, readJsonObject } from "../http.js";

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export type TelegramCall = (method: string, body: Record<string, unknown>) => Promise<unknown>;

const CAPABILITIES: ReadonlySet<ChannelCapability> = new Set<ChannelCapability>([
  "post", "edit", "react", "upload", "download", "authorName", "placeName",
]);

/** Numeric chat ids go out as numbers, @channel usernames as strings. */
function chatId(placeId: string): number | string {
  return /^-?\d{1,24}$/.test(placeId) ? Number(placeId) : placeId;
}

function messageId(id: string): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new Error("Telegram message id is malformed.");
  return value;
}

function resultOf(response: unknown): Record<string, unknown> {
  const result = (response as { result?: unknown } | null)?.result;
  return typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
}

export function telegramMentions(text: string): string[] {
  return dedupeIds([...text.matchAll(/(?:^|[^\w@])@([A-Za-z]\w{3,31})\b/g)].map((m) => m[1] ?? ""));
}

export function createTelegramAdapter(input: {
  token: string;
  call?: TelegramCall;
  fetch?: typeof fetch;
}): ChannelAdapter {
  const fetchImpl = input.fetch ?? fetch;
  const call: TelegramCall = input.call ?? (async (method, body) => {
    const response = await channelFetch(fetchImpl, `Telegram ${method}`, `${TELEGRAM_API}/bot${input.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await readJsonObject(response);
    if (!response.ok || json.ok !== true) {
      const reason = typeof json.description === "string" ? json.description : "unparseable response";
      throw new Error(`Telegram ${method} failed (${response.status}): ${reason}`);
    }
    return json;
  });
  const unsupported = (capability: ChannelCapability) => Promise.reject(new ChannelUnsupportedError("telegram", capability));
  return {
    channel: "telegram",
    capabilities: CAPABILITIES,
    async post(post) {
      const response = await call("sendMessage", {
        chat_id: chatId(post.placeId),
        ...(post.threadId ? { message_thread_id: messageId(post.threadId) } : {}),
        ...(post.replyToMessageId
          ? { reply_parameters: { message_id: messageId(post.replyToMessageId), allow_sending_without_reply: !post.threadId } }
          : {}),
        text: post.text,
        ...post.native,
      });
      return { placeId: post.placeId, messageId: asString(resultOf(response).message_id), ...(post.threadId ? { threadId: post.threadId } : {}) };
    },
    async edit(edit) {
      await call("editMessageText", {
        chat_id: chatId(edit.ref.placeId),
        message_id: messageId(edit.ref.messageId),
        text: edit.text,
        ...edit.native,
      });
    },
    async react(ref, emoji) {
      await call("setMessageReaction", {
        chat_id: chatId(ref.placeId),
        message_id: messageId(ref.messageId),
        reaction: [{ type: "emoji", emoji: reactionGlyph(emoji) }],
      });
    },
    async upload(upload) {
      const form = new FormData();
      form.set("chat_id", String(upload.placeId));
      if (upload.threadId) form.set("message_thread_id", String(messageId(upload.threadId)));
      if (upload.comment) form.set("caption", upload.comment);
      form.set("document", new Blob([upload.data], { type: upload.contentType }), upload.filename);
      const response = await channelFetch(fetchImpl, "Telegram sendDocument", `${TELEGRAM_API}/bot${input.token}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const json = await readJsonObject(response);
      if (!response.ok || json.ok !== true) throw new Error(`Telegram sendDocument failed (${response.status}).`);
      const result = resultOf(json);
      if (upload.threadId && asString(result.message_thread_id) !== upload.threadId) throw new Error("Telegram returned an unexpected upload topic.");
      return { placeId: upload.placeId, messageId: asString(result.message_id), ...(upload.threadId ? { threadId: upload.threadId } : {}) } satisfies ChannelMessageRef;
    },
    async download(fileId) {
      const file = resultOf(await call("getFile", { file_id: fileId }));
      const path = asString(file.file_path);
      if (!path) throw new Error("Telegram getFile returned no file_path.");
      return readFile(
        await channelFetch(fetchImpl, "Telegram file download", `${TELEGRAM_API}/file/bot${input.token}/${path}`, { method: "GET" }),
        "Telegram file download",
      );
    },
    history: () => unsupported("history"),
    recent: () => unsupported("recent"),
    async authorName(userId, placeId) {
      const user = placeId
        ? resultOf(await call("getChatMember", { chat_id: chatId(placeId), user_id: Number(userId) })).user as Record<string, unknown> | undefined
        : resultOf(await call("getChat", { chat_id: chatId(userId) }));
      const username = asString(user?.username);
      return username ? `@${username}` : asString(user?.first_name) || userId;
    },
    async placeName(placeId) {
      const chat = resultOf(await call("getChat", { chat_id: chatId(placeId) }));
      return asString(chat.title) || asString(chat.username) || asString(chat.first_name) || placeId;
    },
    mentions: telegramMentions,
  };
}

interface TelegramUser { id?: number; username?: string; first_name?: string; is_bot?: boolean }
interface TelegramMessage {
  message_id?: number;
  message_thread_id?: number;
  chat?: { id?: number; type?: string };
  from?: TelegramUser;
  text?: string;
  entities?: Array<{ type?: string; offset?: number; length?: number; user?: TelegramUser }>;
}

export function telegramDisplayName(user: { username?: string; first_name?: string; id?: number } | undefined): string {
  if (user?.username) return `@${user.username}`;
  return user?.first_name || String(user?.id ?? "unknown");
}

function conversationKeyFor(placeId: string, topicId?: number): string {
  try {
    return buildChatThreadName("telegram", topicId === undefined ? placeId : `${placeId}:${topicId}`);
  } catch {
    return "";
  }
}

function messageMentions(message: TelegramMessage): string[] {
  const text = message.text ?? "";
  const ids: string[] = [];
  for (const entity of message.entities ?? []) {
    if (entity.type === "text_mention" && typeof entity.user?.id === "number") ids.push(String(entity.user.id));
    if (entity.type === "mention" && typeof entity.offset === "number" && typeof entity.length === "number") {
      ids.push(text.slice(entity.offset + 1, entity.offset + entity.length));
    }
  }
  return dedupeIds(ids.length ? ids : telegramMentions(text));
}

export const telegramTransport: ChannelTransport = {
  channel: "telegram",
  async verify(_rawBody, headers, env) {
    const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
    if (!token || !secret) {
      return { ok: false, status: 503, error: "Telegram is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET." };
    }
    if (!timingSafeEqual(headers.get(TELEGRAM_SECRET_HEADER) ?? "", secret)) {
      return { ok: false, status: 401, error: "Invalid Telegram secret token." };
    }
    return { ok: true };
  },
  parse(rawBody) {
    let update: { update_id?: unknown; message?: TelegramMessage; callback_query?: { id?: string; from?: TelegramUser; data?: string; message?: TelegramMessage } };
    try {
      update = JSON.parse(rawBody) as typeof update;
    } catch {
      return null;
    }
    if (typeof update !== "object" || update === null || typeof update.update_id !== "number") return null;
    const deliveryId = String(update.update_id);
    const query = update.callback_query;
    if (query) {
      const placeId = asString(query.message?.chat?.id);
      return {
        kind: "action",
        channel: "telegram",
        deliveryId,
        conversationKey: conversationKeyFor(placeId, query.message?.message_thread_id),
        placeId,
        ...(typeof query.message?.message_id === "number" ? { messageId: String(query.message.message_id) } : {}),
        ...(typeof query.message?.text === "string" ? { messageText: query.message.text } : {}),
        actorId: asString(query.from?.id),
        actorName: telegramDisplayName(query.from),
        actionId: query.id ?? "",
        value: query.data ?? "",
        raw: query,
      };
    }
    const message = update.message;
    if (!message) return null;
    const placeId = asString(message.chat?.id);
    return {
      kind: "message",
      channel: "telegram",
      deliveryId,
      conversationKey: conversationKeyFor(placeId, message.message_thread_id),
      placeId,
      messageId: asString(message.message_id),
      ...(typeof message.message_thread_id === "number" ? { threadId: String(message.message_thread_id) } : {}),
      authorId: asString(message.from?.id),
      authorName: telegramDisplayName(message.from),
      text: message.text ?? "",
      mentionedUserIds: messageMentions(message),
      isDirect: message.chat?.type === "private",
      isBot: message.from?.is_bot === true,
      raw: message,
    };
  },
  conversationKey: (event: InboundEvent) => event.conversationKey,
};

export const telegramChannel: ChannelDefinition = {
  id: "telegram",
  requiredSecrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
  transport: telegramTransport,
  createAdapter(env: Env, options: ChannelAdapterOptions = {}) {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    return token ? createTelegramAdapter({ token, ...(options.fetch ? { fetch: options.fetch } : {}) }) : null;
  },
};
