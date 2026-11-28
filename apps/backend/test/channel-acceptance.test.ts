/**
 * Channel acceptance matrix: one row per chat platform, run through the
 * shared harness in test/helpers/channel-acceptance.ts. A new lane plugs in
 * by adding one row — the security invariants are not negotiable per lane.
 * See docs/architecture/channel-acceptance.md.
 */
import { describe, vi } from "vitest";
import { discordChannel } from "../src/channels/discord/index.js";
import { slackChannel } from "../src/channels/slack/index.js";
import { createTeamsTransport, teamsChannel } from "../src/channels/teams/index.js";
import { telegramChannel } from "../src/channels/telegram/index.js";
import type { OrchestratorStub } from "../src/chat-lane.js";
import {
  DISCORD_INTERACTIONS_PATH,
  handleDiscordInteractions,
  type DiscordDeps,
} from "../src/discord.js";
import type { Env } from "../src/env.js";
import type { ChannelAdapter, ChannelPostInput } from "../src/ports/channel/index.js";
import { clearSeenSlackEvents, handleSlackEvents, SLACK_EVENTS_PATH } from "../src/slack-events.js";
import { clearSeenTeamsActivities, handleTeamsMessages, TEAMS_MESSAGES_PATH, type TeamsDeps } from "../src/teams.js";
import { clearSeenTelegramUpdates, handleTelegramWebhook, TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH, type TelegramDeps } from "../src/telegram.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import {
  runChannelAcceptanceMatrix,
  runChannelAcceptanceSuite,
  type ChannelAcceptanceRow,
  type LaneAcceptanceFixture,
} from "./helpers/channel-acceptance.js";

const REPO = "https://github.com/owner/repo";
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (data: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof data === "string" ? new TextEncoder().encode(data) : data)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Recording orchestrator stub shared by the lane fixtures. */
function orchestrator(approvalId: string) {
  const runBodies: Record<string, unknown>[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (request.url.endsWith("/api/runs")) {
        runBodies.push(body);
        return Response.json({ ok: true, approvalId });
      }
      return Response.json({ result: body.approved ? "approved" : "rejected" });
    },
  };
  return { runBodies, resolveOrchestrator: vi.fn(async () => stub) };
}

const passThroughCtx = { waitUntil: () => {} } as never;

/* ---------------------------------------------------------------- Slack */

const SLACK_SECRET = "slack-signing-secret";
const slackMessageBody = JSON.stringify({
  type: "event_callback",
  event_id: "EvAcc1",
  team_id: "T1",
  event: { type: "app_mention", user: "U1", text: `<@UBOT> ${REPO} fix it`, ts: "1700000000.000100", channel: "C1" },
});

async function slackSign(rawBody: string): Promise<Headers> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Headers({
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${await hmacHex(SLACK_SECRET, `v0:${timestamp}:${rawBody}`)}`,
  });
}

function slackLane(): LaneAcceptanceFixture {
  let work = 0;
  const env = { SLACK_SIGNING_SECRET: SLACK_SECRET } as Env;
  const request = (headers: Headers) =>
    new Request(`https://worker.test${SLACK_EVENTS_PATH}`, { method: "POST", headers, body: slackMessageBody });
  return {
    reset: () => {
      work = 0;
      clearSeenSlackEvents();
    },
    signedTaskRequest: async () => request(await slackSign(slackMessageBody)),
    unsignedTaskRequest: async () => request(new Headers()),
    handle: (req) => handleSlackEvents(req, env, passThroughCtx, { onEvent: async () => { work += 1; } }),
    workCount: () => work,
  };
}

/* -------------------------------------------------------------- Telegram */

const TG_SECRET = "tg-secret";
const telegramUpdate = JSON.stringify({
  update_id: 9101,
  message: {
    message_id: 5,
    chat: { id: -100123, type: "group" },
    from: { id: 42, username: "alice" },
    text: `/shiba ${REPO} fix the login bug`,
  },
});

function telegramLane(): LaneAcceptanceFixture {
  const { runBodies, resolveOrchestrator } = orchestrator("tg-approval");
  const env = { TELEGRAM_BOT_TOKEN: "123:tg", TELEGRAM_WEBHOOK_SECRET: TG_SECRET } as Env;
  const deps: TelegramDeps = {
    call: async () => ({ ok: true }),
    resolveOrchestrator,
  };
  const request = (secret: string | null) =>
    new Request(`https://worker.test${TELEGRAM_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret === null ? {} : { [TELEGRAM_SECRET_HEADER]: secret }) },
      body: telegramUpdate,
    });
  return {
    reset: () => {
      runBodies.length = 0;
      clearSeenTelegramUpdates();
    },
    signedTaskRequest: async () => request(TG_SECRET),
    unsignedTaskRequest: async () => request("wrong-secret"),
    handle: (req) => handleTelegramWebhook(req, env, undefined, deps),
    workCount: () => runBodies.length,
  };
}

/* --------------------------------------------------------------- Discord */

const discordKeys = crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

function discordInteractionBody() {
  return JSON.stringify({
    id: "interaction-acc-1",
    type: 2,
    application_id: "999000111",
    token: "tok-abc",
    channel_id: "777777777777777777",
    member: { user: { id: "42" } },
    data: { name: "shiba", options: [{ name: "repo", value: REPO }, { name: "task", value: "fix the login bug" }] },
  });
}

/** In-memory stand-in for the Automations DO /internal/dedupe endpoint. */
function fakeAutomationsNamespace() {
  const seen = new Set<string>();
  const namespace = {
    idFromName: () => "acceptance",
    get: () => ({
      fetch: async (input: Request | string) => {
        const body = (await new Request(input).json()) as { key?: string };
        if (typeof body.key === "string" && seen.has(body.key)) return Response.json({ seen: true });
        if (typeof body.key === "string") seen.add(body.key);
        return Response.json({ seen: false });
      },
    }),
  };
  return { namespace, clear: () => seen.clear() };
}

async function discordLane(keys: CryptoKeyPair, publicKey: string): Promise<LaneAcceptanceFixture> {
  const { runBodies, resolveOrchestrator } = orchestrator("dc-approval");
  const automations = fakeAutomationsNamespace();
  const env = { DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "discord-bot", Automations: automations.namespace } as unknown as Env;
  const deps: DiscordDeps = {
    send: async () => {},
    resolveOrchestrator,
  };
  const sign = async (rawBody: string, keyPair: CryptoKeyPair) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(timestamp + rawBody));
    return new Headers({ "X-Signature-Ed25519": hex(signature), "X-Signature-Timestamp": timestamp, "Content-Type": "application/json" });
  };
  const request = (headers: Headers) =>
    new Request(`https://worker.test${DISCORD_INTERACTIONS_PATH}`, { method: "POST", headers, body: discordInteractionBody() });
  return {
    reset: () => {
      runBodies.length = 0;
      automations.clear();
    },
    signedTaskRequest: async () => request(await sign(discordInteractionBody(), keys)),
    unsignedTaskRequest: async () => request(new Headers({ "Content-Type": "application/json" })),
    handle: (req) => handleDiscordInteractions(req, env, undefined, deps),
    workCount: () => runBodies.length,
  };
}

/* ----------------------------------------------------------------- Teams */

const teamsKeys = crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
) as Promise<CryptoKeyPair>;
const TEAMS_SERVICE = "https://smba.trafficmanager.net/teams/";
const TEAMS_CONVERSATION = "19:abc@thread.tacv2";
const TEAMS_APP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEAMS_TENANT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TEAMS_WORKSPACE = "ws_cccccccccccccccccccccccc";

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

function teamsActivity(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message",
    id: "act-acc-1",
    serviceUrl: TEAMS_SERVICE,
    channelId: "msteams",
    from: { id: "29:ana", aadObjectId: "aad-ana", name: "Ana" },
    conversation: { id: TEAMS_CONVERSATION, conversationType: "channel", tenantId: TEAMS_TENANT },
    recipient: { id: "28:bot", name: "Shiba" },
    text: `<at>Shiba</at> ${REPO} fix it`,
    entities: [{ type: "mention", text: "<at>Shiba</at>", mentioned: { id: "28:bot" } }],
    ...extra,
  });
}

async function teamsLane(keys: CryptoKeyPair): Promise<LaneAcceptanceFixture> {
  const { runBodies, resolveOrchestrator } = orchestrator("teams-approval");
  const fixture = customAgentD1();
  fixture.sqlite.prepare("INSERT INTO teams_connections VALUES (?, ?, ?, 'fixture-generation')").run(TEAMS_WORKSPACE, TEAMS_APP, TEAMS_TENANT);
  const env = {
    AGENT_AUDIT: fixture.database,
    TEAMS_APP_ID: TEAMS_APP,
    TEAMS_APP_PASSWORD: "pw",
    TEAMS_APP_TENANT_ID: TEAMS_TENANT,
    TEAMS_WORKSPACE_ID: TEAMS_WORKSPACE,
    TEAMS_APPROVERS: "aad-ana",
  } as Env;
  const adapter = {
    channel: "teams",
    capabilities: new Set(["post", "edit"]),
    post: async (input: ChannelPostInput) => ({ placeId: input.placeId, messageId: "act-2" }),
    edit: async () => {},
  } as unknown as ChannelAdapter;
  const deps: TeamsDeps = {
    adapter,
    transport: createTeamsTransport({ fetch: await teamsKeyFetch(keys) }),
    resolveOrchestrator,
  };
  const signedHeaders = async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTeamsJwt(
      { iss: "https://api.botframework.com", aud: TEAMS_APP, exp: now + 600, nbf: now - 10, serviceurl: TEAMS_SERVICE },
      keys,
    );
    return new Headers({ Authorization: `Bearer ${token}` });
  };
  const request = (headers: Headers) =>
    new Request(`https://worker.test${TEAMS_MESSAGES_PATH}`, { method: "POST", headers, body: teamsActivity() });
  return {
    reset: () => {
      runBodies.length = 0;
      clearSeenTeamsActivities();
    },
    signedTaskRequest: async () => request(await signedHeaders()),
    unsignedTaskRequest: async () => request(new Headers()),
    handle: (req) => handleTeamsMessages(req, env, undefined, deps),
    workCount: () => runBodies.length,
  };
}

/* ------------------------------------------------------------- The matrix */

const slackRow: ChannelAcceptanceRow = {
  channel: "slack",
  definition: slackChannel,
  env: { SLACK_SIGNING_SECRET: SLACK_SECRET, SLACK_BOT_TOKEN: "xoxb-test" } as Env,
  sign: slackSign,
  message: {
    rawBody: slackMessageBody,
    deliveryId: "EvAcc1",
    conversationKey: "slack:T1:C1:1700000000.000100",
  },
  action: {
    rawBody: `payload=${encodeURIComponent(JSON.stringify({
      type: "block_actions",
      trigger_id: "trig-acc-1",
      team: { id: "T1" },
      user: { id: "U9", username: "ana" },
      channel: { id: "C1" },
      container: { channel_id: "C1", message_ts: "1700000000.000200" },
      message: { ts: "1700000000.000200", thread_ts: "1700000000.000100", text: "card" },
      actions: [{ action_id: "shiba_approve", value: "approval-1" }],
    }))}`,
    deliveryId: "trig-acc-1",
    conversationKey: "slack:T1:C1:1700000000.000100",
  },
  approverEnvKey: "SLACK_APPROVERS",
  platformUserId: "U_APPROVER",
  decider: "U_APPROVER",
  lane: slackLane(),
};

const discordRowPromise = (async (): Promise<ChannelAcceptanceRow> => {
  const keys = await discordKeys;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  return {
    channel: "discord",
    definition: discordChannel,
    env: { DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "discord-bot" } as Env,
    async sign(rawBody) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + rawBody));
      return new Headers({ "X-Signature-Ed25519": hex(signature), "X-Signature-Timestamp": timestamp });
    },
    message: { rawBody: discordInteractionBody(), deliveryId: "interaction-acc-1", conversationKey: "discord:777777777777777777" },
    action: {
      rawBody: JSON.stringify({
        id: "interaction-acc-2",
        type: 3,
        channel_id: "777777777777777777",
        user: { id: "42" },
        message: { id: "666", content: "card" },
        data: { custom_id: "shiba:approve:a1" },
      }),
      deliveryId: "interaction-acc-2",
      conversationKey: "discord:777777777777777777",
    },
    approverEnvKey: "DISCORD_APPROVERS",
    platformUserId: "42",
    decider: "discord:42",
    lane: await discordLane(keys, publicKey),
  };
})();

const telegramRow: ChannelAcceptanceRow = {
  channel: "telegram",
  definition: telegramChannel,
  env: { TELEGRAM_BOT_TOKEN: "123:tg", TELEGRAM_WEBHOOK_SECRET: TG_SECRET } as Env,
  bodyUnsigned: true,
  sign: async () => new Headers({ [TELEGRAM_SECRET_HEADER]: TG_SECRET }),
  message: { rawBody: telegramUpdate, deliveryId: "9101", conversationKey: "telegram:-100123" },
  action: {
    rawBody: JSON.stringify({
      update_id: 9102,
      callback_query: { id: "cq1", from: { id: 42 }, data: "shiba:approve:a1", message: { message_id: 6, chat: { id: -100123 }, text: "card" } },
    }),
    deliveryId: "9102",
    conversationKey: "telegram:-100123",
  },
  approverEnvKey: "TELEGRAM_APPROVERS",
  platformUserId: "42",
  decider: "telegram:42",
  lane: telegramLane(),
};

const teamsRowPromise = (async (): Promise<ChannelAcceptanceRow> => {
  const keys = await teamsKeys;
  return {
    channel: "teams",
    definition: { ...teamsChannel, transport: createTeamsTransport({ fetch: await teamsKeyFetch(keys) }) },
    env: { TEAMS_APP_ID: TEAMS_APP, TEAMS_APP_PASSWORD: "pw" } as Env,
    bodyUnsigned: true,
    sign: async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signTeamsJwt(
        { iss: "https://api.botframework.com", aud: TEAMS_APP, exp: now + 600, nbf: now - 10, serviceurl: TEAMS_SERVICE },
        keys,
      );
      return new Headers({ Authorization: `Bearer ${token}` });
    },
    message: {
      rawBody: teamsActivity({ id: "act-acc-msg" }),
      deliveryId: "act-acc-msg",
      conversationKey: `teams:${TEAMS_CONVERSATION}`,
    },
    action: {
      rawBody: teamsActivity({ id: "act-acc-decision", replyToId: "act-2", text: undefined, entities: undefined, value: { shiba: "approve:a1", card: "card" } }),
      deliveryId: "act-acc-decision",
      conversationKey: `teams:${TEAMS_CONVERSATION}`,
    },
    approverEnvKey: "TEAMS_APPROVERS",
    platformUserId: "aad-ana",
    decider: "teams:aad-ana",
    lane: await teamsLane(keys),
  };
})();

const allRows = Promise.all([slackRow, discordRowPromise, telegramRow, teamsRowPromise]);

runChannelAcceptanceSuite("slack", () => slackRow);
runChannelAcceptanceSuite("discord", () => discordRowPromise);
runChannelAcceptanceSuite("telegram", () => telegramRow);
runChannelAcceptanceSuite("teams", () => teamsRowPromise);

describe("channel acceptance matrix", () => {
  runChannelAcceptanceMatrix(() => allRows);
});
