/**
 * Discord channel: REST adapter and interactions transport.
 *
 * Discord signs each interaction with Ed25519 over `timestamp + body`; a
 * stale timestamp is rejected so a captured payload cannot be replayed
 * outside the window. Every outbound message carries an empty
 * allowed_mentions so echoed text never pings anyone.
 */
import { buildChatThreadName, buildDecisionData, parseChatThreadName } from "@shiba/shared";
import type { Env } from "../../env.js";
import { reactionGlyph } from "../emoji.js";
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

export const DISCORD_API = "https://discord.com/api/v10";
/** Same bound as the Slack replay window. */
export const DISCORD_REPLAY_WINDOW_SECONDS = 300;
/** Empty allow-list: task text echoed into a message can never ping anyone. */
export const NO_MENTIONS = { parse: [] as string[] };

export const DISCORD_INTERACTION = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;

function hexBytes(hex: string) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True only for a well-formed, fresh, valid Ed25519 signature over `timestamp + body`. */
export async function verifyDiscordRequest(
  body: string,
  headers: Headers,
  publicKey: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = hexBytes(publicKey.trim());
  const signature = hexBytes(headers.get("x-signature-ed25519") ?? "");
  const timestamp = headers.get("x-signature-timestamp") ?? "";
  if (!key || key.length !== 32 || !signature || signature.length !== 64 || !/^\d+$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > DISCORD_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signature, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const CAPABILITIES: ReadonlySet<ChannelCapability> = new Set<ChannelCapability>([
  "post", "edit", "react", "upload", "download", "history", "recent", "authorName", "placeName",
]);

export function discordMentions(text: string): string[] {
  return dedupeIds([...text.matchAll(/<@!?(\d{1,24})>/g)].map((m) => m[1] ?? ""));
}

interface DiscordMessage {
  id?: string;
  content?: string;
  author?: { id?: string; bot?: boolean };
}

function toHistory(messages: unknown, threadId?: string): ChannelHistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  return (messages as DiscordMessage[]).map((m) => ({
    messageId: m.id ?? "",
    authorId: m.author?.id ?? "",
    text: m.content ?? "",
    isBot: m.author?.bot === true,
    ...(threadId ? { threadId } : {}),
  })).reverse();
}

export function createDiscordAdapter(input: { botToken: string; fetch?: typeof fetch }): ChannelAdapter {
  const fetchImpl = input.fetch ?? fetch;
  const request = async (label: string, method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await channelFetch(fetchImpl, `Discord ${label}`, `${DISCORD_API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bot ${input.botToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const json = await readJsonObject(response);
      const reason = typeof json.message === "string" ? json.message : "unparseable response";
      throw new Error(`Discord ${label} failed (${response.status}): ${reason}`);
    }
    return response;
  };
  const json = async (label: string, method: string, path: string, body?: unknown) =>
    (await request(label, method, path, body)).json().catch(() => ({})) as Promise<unknown>;
  const object = (value: unknown) => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {});
  const limit = (n: number | undefined) => Math.min(Math.max(Math.trunc(n ?? 50), 1), 100);
  return {
    channel: "discord",
    capabilities: CAPABILITIES,
    async post(post) {
      const target = post.threadId ?? post.placeId;
      const sent = object(await json("post", "POST", `/channels/${target}/messages`, {
        content: post.text,
        allowed_mentions: NO_MENTIONS,
        ...(post.replyToMessageId ? { message_reference: { message_id: post.replyToMessageId, fail_if_not_exists: false } } : {}),
        ...post.native,
      }));
      return { placeId: post.placeId, messageId: asString(sent.id), ...(post.threadId ? { threadId: post.threadId } : {}) };
    },
    async edit(edit) {
      await request("edit", "PATCH", `/channels/${edit.ref.threadId ?? edit.ref.placeId}/messages/${edit.ref.messageId}`, {
        content: edit.text,
        allowed_mentions: NO_MENTIONS,
        ...edit.native,
      });
    },
    async react(ref, emoji) {
      await request("react", "PUT", `/channels/${ref.threadId ?? ref.placeId}/messages/${ref.messageId}/reactions/${encodeURIComponent(reactionGlyph(emoji))}/@me`);
    },
    async upload(upload) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ content: upload.comment ?? "", allowed_mentions: NO_MENTIONS }));
      form.set("files[0]", new Blob([upload.data], { type: upload.contentType }), upload.filename);
      const response = await channelFetch(fetchImpl, "Discord upload", `${DISCORD_API}/channels/${upload.threadId ?? upload.placeId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${input.botToken}` },
        body: form,
      });
      if (!response.ok) throw new Error(`Discord upload failed (${response.status}).`);
      const sent = await readJsonObject(response);
      return { placeId: upload.placeId, messageId: asString(sent.id), ...(upload.threadId ? { threadId: upload.threadId } : {}) };
    },
    async download(url) {
      // Attachment URLs are signed CDN links; never send the bot token there.
      if (!/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//.test(url)) {
        throw new Error("Discord download only fetches Discord CDN attachment URLs.");
      }
      return readFile(await channelFetch(fetchImpl, "Discord download", url, { method: "GET" }), "Discord download");
    },
    async history(_placeId, threadId, max) {
      return toHistory(await json("history", "GET", `/channels/${threadId}/messages?limit=${limit(max)}`), threadId);
    },
    async recent(placeId, max) {
      return toHistory(await json("recent", "GET", `/channels/${placeId}/messages?limit=${limit(max)}`));
    },
    async authorName(userId) {
      const user = object(await json("user", "GET", `/users/${userId}`));
      return asString(user.global_name) || asString(user.username) || userId;
    },
    async placeName(placeId) {
      const channel = object(await json("channel", "GET", `/channels/${placeId}`));
      const name = asString(channel.name);
      return name ? `#${name}` : placeId;
    },
    mentions: discordMentions,
  };
}

export function decisionButtons(approvalId: string): unknown[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Approve", custom_id: buildDecisionData(true, approvalId) },
      { type: 2, style: 4, label: "Reject", custom_id: buildDecisionData(false, approvalId) },
    ],
  }];
}

/** Post the second publication approval into the originating Discord channel. */
export async function postDiscordPublicationApproval(
  env: Env,
  threadKey: string,
  text: string,
  approvalId: string,
  deps: { adapter?: ReturnType<typeof createDiscordAdapter> } = {},
): Promise<boolean> {
  const chat = parseChatThreadName(threadKey);
  if (chat?.platform !== "discord") return false;
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const adapter = deps.adapter ?? (botToken ? createDiscordAdapter({ botToken }) : null);
  if (!adapter) return false;
  await adapter.post({
    placeId: chat.conversationId,
    text: text.slice(0, 1900),
    native: { components: decisionButtons(approvalId) },
  });
  return true;
}

interface DiscordInteraction {
  id?: string;
  type?: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string; username?: string; bot?: boolean } };
  user?: { id?: string; username?: string; bot?: boolean };
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<{ name?: string; value?: unknown }>;
    resolved?: { users?: Record<string, unknown> };
  };
  message?: { id?: string; content?: string };
}

function conversationKeyFor(placeId: string): string {
  try {
    return buildChatThreadName("discord", placeId);
  } catch {
    return "";
  }
}

export const discordTransport: ChannelTransport = {
  channel: "discord",
  async verify(rawBody, headers, env, now) {
    const publicKey = env.DISCORD_PUBLIC_KEY?.trim() ?? "";
    if (!publicKey) return { ok: false, status: 503, error: "Discord is not configured: set DISCORD_PUBLIC_KEY." };
    if (!(await verifyDiscordRequest(rawBody, headers, publicKey, now))) {
      return { ok: false, status: 401, error: "Invalid Discord signature." };
    }
    return { ok: true };
  },
  parse(rawBody) {
    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody) as DiscordInteraction;
    } catch {
      return null;
    }
    if (typeof interaction !== "object" || interaction === null) return null;
    const user = interaction.member?.user ?? interaction.user;
    const placeId = interaction.channel_id ?? "";
    const base = {
      channel: "discord" as const,
      deliveryId: interaction.id ?? "",
      conversationKey: conversationKeyFor(placeId),
      placeId,
      ...(interaction.guild_id ? { workspaceId: interaction.guild_id } : {}),
      raw: interaction,
    };
    if (interaction.type === DISCORD_INTERACTION.APPLICATION_COMMAND) {
      const options: Record<string, string> = {};
      for (const option of interaction.data?.options ?? []) {
        if (option.name && typeof option.value === "string") options[option.name] = option.value;
      }
      const text = Object.values(options).join(" ");
      return {
        ...base,
        kind: "message",
        messageId: interaction.id ?? "",
        authorId: user?.id ?? "",
        ...(user?.username ? { authorName: user.username } : {}),
        text,
        mentionedUserIds: dedupeIds([...discordMentions(text), ...Object.keys(interaction.data?.resolved?.users ?? {})]),
        isDirect: !interaction.guild_id,
        isBot: user?.bot === true,
        command: { name: interaction.data?.name ?? "", options },
      };
    }
    if (interaction.type === DISCORD_INTERACTION.MESSAGE_COMPONENT) {
      const customId = interaction.data?.custom_id ?? "";
      return {
        ...base,
        kind: "action",
        ...(interaction.message?.id ? { messageId: interaction.message.id } : {}),
        ...(typeof interaction.message?.content === "string" ? { messageText: interaction.message.content } : {}),
        actorId: user?.id ?? "",
        ...(user?.username ? { actorName: user.username } : {}),
        actionId: customId,
        value: customId,
      };
    }
    return null;
  },
  conversationKey: (event: InboundEvent) => conversationKeyFor(event.placeId),
};

export const discordChannel: ChannelDefinition = {
  id: "discord",
  requiredSecrets: ["DISCORD_PUBLIC_KEY"],
  transport: discordTransport,
  createAdapter(env: Env, options: ChannelAdapterOptions = {}) {
    const botToken = env.DISCORD_BOT_TOKEN?.trim();
    return botToken ? createDiscordAdapter({ botToken, ...(options.fetch ? { fetch: options.fetch } : {}) }) : null;
  },
};
