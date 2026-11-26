import { describe, expect, it } from "vitest";
import { discordChannel } from "../src/channels/discord/index.js";
import { createSlackAdapter, slackChannel } from "../src/channels/slack/index.js";
import { createTeamsTransport, teamsChannel } from "../src/channels/teams/index.js";
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
  bodyUnsigned: true,
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

const teamsKeys = crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
) as Promise<CryptoKeyPair>;
const b64url = (data: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof data === "string" ? new TextEncoder().encode(data) : data)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TEAMS_SERVICE = "https://smba.trafficmanager.net/teams/";
const TEAMS_CONVERSATION = "19:abc@thread.tacv2";

async function signTeamsJwt(claims: Record<string, unknown>, keys: CryptoKeyPair): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

async function teamsKeyFetch(keys: CryptoKeyPair): Promise<typeof fetch> {
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/openidconfiguration")) return json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
    return json({ keys: [{ kty: "RSA", kid: "k1", n: jwk.n, e: jwk.e, endorsements: ["msteams"] }] });
  }) as typeof fetch;
}

runChannelContractSuite("teams", async () => {
  const keys = await teamsKeys;
  const activity = (extra: Record<string, unknown>) => JSON.stringify({
    type: "message",
    serviceUrl: TEAMS_SERVICE,
    channelId: "msteams",
    from: { id: "29:ana", aadObjectId: "aad-ana", name: "Ana" },
    conversation: { id: TEAMS_CONVERSATION, conversationType: "channel", tenantId: "tid" },
    recipient: { id: "28:bot", name: "Shiba" },
    ...extra,
  });
  return {
    definition: { ...teamsChannel, transport: createTeamsTransport({ fetch: await teamsKeyFetch(keys) }) },
    env: { TEAMS_APP_ID: "app-1", TEAMS_APP_PASSWORD: "pw" } as Env,
    bodyUnsigned: true,
    sign: async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signTeamsJwt(
        { iss: "https://api.botframework.com", aud: "app-1", exp: now + 600, nbf: now - 10, serviceurl: TEAMS_SERVICE },
        keys,
      );
      return new Headers({ Authorization: `Bearer ${token}` });
    },
    message: {
      rawBody: activity({
        id: "act-1",
        text: "<at>Shiba</at> hello <at>Bob</at>",
        entities: [
          { type: "mention", text: "<at>Shiba</at>", mentioned: { id: "28:bot" } },
          { type: "mention", text: "<at>Bob</at>", mentioned: { id: "29:bob" } },
        ],
      }),
      expected: {
        deliveryId: "act-1",
        placeId: TEAMS_CONVERSATION,
        authorId: "aad-ana",
        text: "<at>Shiba</at> hello <at>Bob</at>",
        mentionedUserIds: ["28:bot", "29:bob"],
        conversationKey: `teams:${TEAMS_CONVERSATION}`,
      },
    },
    action: {
      rawBody: activity({ id: "act-3", replyToId: "act-2", value: { shiba: "approve:a1", card: "card" } }),
      expected: { deliveryId: "act-3", placeId: TEAMS_CONVERSATION, actorId: "aad-ana", value: "approve:a1", conversationKey: `teams:${TEAMS_CONVERSATION}` },
    },
    mentions: { text: "<at>Alice</at> and <at>Bob</at> and <at>Alice</at>", ids: ["Alice", "Bob"] },
    respond(url) {
      if (url.hostname === "login.microsoftonline.com") return json({ access_token: "tok", expires_in: 3600 });
      if (url.pathname.includes("/attachments/")) return bytes();
      return json({ id: "act-9" });
    },
    hosts: ["login.microsoftonline.com", "smba.trafficmanager.net"],
    ref: { placeId: TEAMS_CONVERSATION, messageId: "act-2" },
    thread: { placeId: TEAMS_CONVERSATION, threadId: "act-2" },
    file: "https://smba.trafficmanager.net/teams/v3/attachments/a1/views/original",
  };
});

describe("teams transport", () => {
  it("rejects a token for another app, another serviceUrl, an expired token or an unendorsed channel", async () => {
    const keys = await teamsKeys;
    const transport = createTeamsTransport({ fetch: await teamsKeyFetch(keys) });
    const env = { TEAMS_APP_ID: "app-1", TEAMS_APP_PASSWORD: "pw" } as Env;
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "https://api.botframework.com", aud: "app-1", exp: now + 600, serviceUrl: TEAMS_SERVICE };
    const body = (channelId = "msteams") => JSON.stringify({ type: "message", id: "1", serviceUrl: TEAMS_SERVICE, channelId });
    const check = async (claims: Record<string, unknown>, raw = body()) =>
      transport.verify(raw, new Headers({ Authorization: `Bearer ${await signTeamsJwt(claims, keys)}` }), env);
    expect(await check(good)).toEqual({ ok: true });
    const { serviceUrl, ...rest } = good;
    expect(await check({ ...rest, serviceurl: serviceUrl })).toEqual({ ok: true });
    expect(await check({ ...good, serviceurl: "https://evil.example/" })).toMatchObject({ ok: false, status: 401 });
    expect(await check({ ...good, aud: "other" })).toMatchObject({ ok: false, status: 401 });
    expect(await check({ ...good, iss: "https://evil.example" })).toMatchObject({ ok: false, status: 401 });
    expect(await check({ ...good, serviceUrl: "https://evil.example/" })).toMatchObject({ ok: false, status: 401 });
    expect(await check({ ...good, exp: now - 3600 })).toMatchObject({ ok: false, status: 401 });
    expect(await check(good, body("webchat"))).toMatchObject({ ok: false, status: 401 });
    const other = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const forged = await signTeamsJwt(good, other);
    expect(await transport.verify(body(), new Headers({ Authorization: `Bearer ${forged}` }), env)).toMatchObject({ ok: false, status: 401 });
  });

  it("only sends the bot token to the Connector host on download", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "tok", expires_in: 3600 });
      return bytes();
    }) as typeof fetch;
    const adapter = teamsChannel.createAdapter({ TEAMS_APP_ID: "app-1", TEAMS_APP_PASSWORD: "pw" } as Env, { fetch: fetchImpl })!;
    await adapter.download("https://contoso.sharepoint.com/file.txt");
    expect(seen.find((s) => s.url.includes("sharepoint"))?.auth).toBeNull();
    await adapter.download(`${TEAMS_SERVICE}v3/attachments/a/views/original`);
    expect(seen.find((s) => s.url.includes("/v3/attachments/"))?.auth).toBe("Bearer tok");
    await expect(adapter.download("http://smba.trafficmanager.net/x")).rejects.toThrow();
  });
});

describe("channel registry", () => {
  it("registers slack, discord, telegram, teams and email and resolves conversation keys to their channel", () => {
    expect(listChannels().map((c) => c.id).sort()).toEqual(["discord", "email", "slack", "teams", "telegram"]);
    expect(channelForConversationKey(`teams:${TEAMS_CONVERSATION}`)).toBe(teamsChannel);
    expect(getChannel("slack")).toBe(slackChannel);
    expect(channelForConversationKey("slack:T1:C1:1.2")).toBe(slackChannel);
    expect(channelForConversationKey("telegram:-100")).toBe(telegramChannel);
    expect(channelForConversationKey("discord:1")).toBe(discordChannel);
    expect(channelForConversationKey("web:abc")).toBeNull();
    expect(channelForConversationKey("constructor:x")).toBeNull();
  });
});

describe("channel adapter outbound details", () => {
  const capture = (reply: unknown) => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return json(reply);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("posts Slack blocks with the selected persona and returns the provider receipt", async () => {
    const slack = capture({ ok: true, channel: "C2", ts: "1.3" });
    const adapter = slackChannel.createAdapter({ SLACK_BOT_TOKEN: "x" } as Env, { fetch: slack.fetchImpl });
    if (!adapter) throw new Error("Expected an outbound adapter for the configured token");
    const blocks = [{ type: "section", text: { type: "plain_text", text: "Review" } }];

    await expect(adapter.post({
      placeId: "C1", threadId: "1.2", text: "Review", native: { blocks }, persona: "reviewer",
    })).resolves.toEqual({ placeId: "C2", messageId: "1.3", threadId: "1.2" });
    expect(slack.calls).toHaveLength(1);
    expect(JSON.parse(slack.calls[0]?.body ?? "{}")).toEqual({
      channel: "C1", thread_ts: "1.2", text: "Review", blocks,
      username: "Shiba Reviewer", icon_emoji: ":eyes:",
    });
  });

  it("preserves Slack's rejection and whether the delivery outcome is known", async () => {
    const slack = capture({ ok: false, error: "not_in_channel" });
    const adapter = createSlackAdapter({ token: "x", fetch: slack.fetchImpl });
    await expect(adapter.post({ placeId: "C1", text: "Review" })).rejects.toMatchObject({
      name: "SlackPostRejectedError", message: "not_in_channel", outcomeKnown: true,
    });
  });

  it("converts reaction names and glyphs to each platform's format", async () => {
    const slack = capture({ ok: true });
    await slackChannel.createAdapter({ SLACK_BOT_TOKEN: "x" } as Env, { fetch: slack.fetchImpl })!.react({ placeId: "C1", messageId: "1.2" }, "👀");
    expect(JSON.parse(slack.calls[0]!.body)).toMatchObject({ name: "eyes" });

    const discord = capture({});
    await discordChannel.createAdapter({ DISCORD_BOT_TOKEN: "d" } as Env, { fetch: discord.fetchImpl })!.react({ placeId: "1", messageId: "2" }, ":eyes:");
    expect(discord.calls[0]!.url).toContain(`/reactions/${encodeURIComponent("👀")}/@me`);

    const telegram = capture({ ok: true, result: true });
    await telegramChannel.createAdapter({ TELEGRAM_BOT_TOKEN: "t" } as Env, { fetch: telegram.fetchImpl })!.react({ placeId: "5", messageId: "9" }, "eyes");
    expect(JSON.parse(telegram.calls[0]!.body).reaction).toEqual([{ type: "emoji", emoji: "👀" }]);
  });

  it("keeps the thread on a Discord upload reference", async () => {
    const discord = capture({ id: "m1" });
    const ref = await discordChannel.createAdapter({ DISCORD_BOT_TOKEN: "d" } as Env, { fetch: discord.fetchImpl })!
      .upload({ placeId: "1", threadId: "t1", filename: "a.txt", contentType: "text/plain", data: new TextEncoder().encode("hi") });
    expect(ref).toEqual({ placeId: "1", messageId: "m1", threadId: "t1" });
    expect(discord.calls[0]!.url).toContain("/channels/t1/messages");
  });

  it("passes Slack native options through on post and edit", async () => {
    const slack = capture({ ok: true, channel: "C1", ts: "1.2" });
    const adapter = slackChannel.createAdapter({ SLACK_BOT_TOKEN: "x" } as Env, { fetch: slack.fetchImpl })!;
    await adapter.post({ placeId: "C1", threadId: "1.1", text: "hi", native: { unfurl_links: false, blocks: [], channel: "C9", thread_ts: "9.9" } });
    await adapter.edit({ ref: { placeId: "C1", messageId: "1.2" }, text: "hi", native: { unfurl_links: false, channel: "C9", ts: "9.9" } });
    expect(JSON.parse(slack.calls[0]!.body)).toMatchObject({ unfurl_links: false, blocks: [], channel: "C1", thread_ts: "1.1" });
    expect(JSON.parse(slack.calls[1]!.body)).toEqual({ channel: "C1", ts: "1.2", text: "hi", unfurl_links: false });
  });
});
