import { describe, expect, it } from "vitest";
import { discordChannel } from "../src/channels/discord/index.js";
import { slackChannel } from "../src/channels/slack/index.js";
import { telegramChannel } from "../src/channels/telegram/index.js";
import type { Env } from "../src/env.js";
import { runChannelContractSuite } from "../src/ports/channel/contract-suite.js";
import { channelForConversationKey, getChannel, listChannels } from "../src/ports/channel/registry.js";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bytes = () => new Response(new Uint8Array([104, 105]), { headers: { "content-type": "text/plain" } });

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SLACK_SECRET = "slack-signing-secret";

runChannelContractSuite("slack", () => ({
  definition: slackChannel,
  env: { SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_BOT_TOKEN: "xoxb-test" } as Env,
  async sign(rawBody) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return new Headers({
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": `v0=${await hmacHex(SLACK_SECRET, `v0:${timestamp}:${rawBody}`)}`,
    });
  },
  message: {
    rawBody: JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T1",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> hello <@U2>", ts: "1700000000.000100", channel: "C1" },
    }),
    expected: {
      deliveryId: "Ev1",
      placeId: "C1",
      authorId: "U1",
      text: "<@UBOT> hello <@U2>",
      mentionedUserIds: ["UBOT", "U2"],
      conversationKey: "slack:T1:C1:1700000000.000100",
    },
  },
  action: {
    rawBody: `payload=${encodeURIComponent(JSON.stringify({
      type: "block_actions",
      trigger_id: "trig1",
      team: { id: "T1" },
      user: { id: "U9", username: "ana" },
      channel: { id: "C1" },
      container: { channel_id: "C1", message_ts: "1700000000.000200" },
      message: { ts: "1700000000.000200", thread_ts: "1700000000.000100", text: "card" },
      actions: [{ action_id: "shiba_approve", value: "approval-1" }],
    }))}`,
    expected: {
      deliveryId: "trig1",
      placeId: "C1",
      actorId: "U9",
      value: "approval-1",
      conversationKey: "slack:T1:C1:1700000000.000100",
    },
  },
  mentions: { text: "<@U1> and <@U2|bob> then <@U1>", ids: ["U1", "U2"] },
  respond(url) {
    if (url.hostname === "files.slack.com") return url.pathname.startsWith("/upload") ? new Response("OK") : bytes();
    const method = url.pathname.replace("/api/", "");
    switch (method) {
      case "chat.postMessage": return json({ ok: true, channel: "C1", ts: "1700000000.000300" });
      case "files.getUploadURLExternal": return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" });
      case "conversations.replies":
      case "conversations.history": return json({ ok: true, messages: [{ ts: "1700000000.000100", user: "U1", text: "hi" }] });
      case "users.info": return json({ ok: true, user: { name: "ana", profile: { display_name: "Ana" } } });
      case "conversations.info": return json({ ok: true, channel: { name: "general" } });
      default: return json({ ok: true });
    }
  },
  hosts: ["slack.com", "files.slack.com"],
  ref: { placeId: "C1", messageId: "1700000000.000100" },
  thread: { placeId: "C1", threadId: "1700000000.000100" },
  file: "https://files.slack.com/files-pri/T1-F1/notes.txt",
}));

const discordKeys = crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

runChannelContractSuite("discord", async () => {
  const keys = await discordKeys;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  return {
    definition: discordChannel,
    env: { DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "discord-bot" } as Env,
    async sign(rawBody) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + rawBody));
      return new Headers({ "X-Signature-Ed25519": hex(signature), "X-Signature-Timestamp": timestamp });
    },
    message: {
      rawBody: JSON.stringify({
        id: "111",
        type: 2,
        guild_id: "900",
        channel_id: "222",
        member: { user: { id: "333", username: "ana" } },
        data: { name: "shiba", options: [{ name: "task", value: "hello <@444>" }, { name: "repo", value: "https://github.com/o/r" }] },
      }),
      expected: {
        deliveryId: "111",
        placeId: "222",
        authorId: "333",
        text: "hello <@444> https://github.com/o/r",
        mentionedUserIds: ["444"],
        conversationKey: "discord:222",
      },
    },
    action: {
      rawBody: JSON.stringify({
        id: "112",
        type: 3,
        guild_id: "900",
        channel_id: "222",
        user: { id: "555" },
        message: { id: "666", content: "card" },
        data: { custom_id: "shiba:approve:a1" },
      }),
      expected: { deliveryId: "112", placeId: "222", actorId: "555", value: "shiba:approve:a1", conversationKey: "discord:222" },
    },
    mentions: { text: "<@1> <@!2> <@1>", ids: ["1", "2"] },
    respond(url, init) {
      if (url.hostname === "cdn.discordapp.com") return bytes();
      if ((init.method ?? "GET") === "GET" && url.pathname.endsWith("/messages")) {
        return json([{ id: "2", content: "b", author: { id: "9" } }, { id: "1", content: "a", author: { id: "8", bot: true } }]);
      }
      if (init.method === "PUT") return new Response(null, { status: 204 });
      return json({ id: "777", name: "general", username: "ana" });
    },
    hosts: ["discord.com", "cdn.discordapp.com"],
    ref: { placeId: "222", messageId: "666" },
    thread: { placeId: "222", threadId: "223" },
    file: "https://cdn.discordapp.com/attachments/222/1/notes.txt",
  };
});

runChannelContractSuite("telegram", () => ({
  definition: telegramChannel,
  env: { TELEGRAM_BOT_TOKEN: "123:tg", TELEGRAM_WEBHOOK_SECRET: "tg-secret" } as Env,
  sign: async () => new Headers({ "X-Telegram-Bot-Api-Secret-Token": "tg-secret" }),
  message: {
    rawBody: JSON.stringify({
      update_id: 10,
      message: {
        message_id: 5,
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "ana" },
        text: "/shiba hello @bob",
        entities: [{ type: "bot_command", offset: 0, length: 6 }, { type: "mention", offset: 13, length: 4 }],
      },
    }),
    expected: {
      deliveryId: "10",
      placeId: "-100",
      authorId: "42",
      text: "/shiba hello @bob",
      mentionedUserIds: ["bob"],
      conversationKey: "telegram:-100",
    },
  },
  action: {
    rawBody: JSON.stringify({
      update_id: 11,
      callback_query: { id: "cq1", from: { id: 43 }, data: "shiba:approve:a1", message: { message_id: 6, chat: { id: -100 }, text: "card" } },
    }),
    expected: { deliveryId: "11", placeId: "-100", actorId: "43", value: "shiba:approve:a1", conversationKey: "telegram:-100" },
  },
  mentions: { text: "ping @alice and @bob_1 and @alice", ids: ["alice", "bob_1"] },
  respond(url) {
    if (url.pathname.startsWith("/file/")) return bytes();
    return json({ ok: true, result: { message_id: 7, file_path: "documents/notes.txt", title: "Team", user: { username: "ana" } } });
  },
  hosts: ["api.telegram.org"],
  ref: { placeId: "-100", messageId: "6" },
  thread: { placeId: "-100", threadId: "6" },
  file: "file-id-1",
}));

describe("channel registry", () => {
  it("registers slack, discord and telegram and resolves conversation keys to their channel", () => {
    expect(listChannels().map((c) => c.id).sort()).toEqual(["discord", "slack", "telegram"]);
    expect(getChannel("slack")).toBe(slackChannel);
    expect(channelForConversationKey("slack:T1:C1:1.2")).toBe(slackChannel);
    expect(channelForConversationKey("telegram:-100")).toBe(telegramChannel);
    expect(channelForConversationKey("discord:1")).toBe(discordChannel);
    expect(channelForConversationKey("web:abc")).toBeNull();
    expect(channelForConversationKey("constructor:x")).toBeNull();
  });
});
