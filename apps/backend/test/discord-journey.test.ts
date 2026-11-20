/**
 * Discord journey, fixture proof against the real Worker routes: install via
 * OAuth2, slash command and bot mention to task, in-channel approval through
 * signed message components, run only after approval, result posted back to
 * the same channel, then disconnect and reconnect. Discord's REST API and
 * the coding harness are deterministic fixtures; no live Discord call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordConnectionStatus } from "@shiba/shared";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { formatAgentResult, parseAgentToolInput, type CodingTaskResult } from "../src/opencode-input.js";
import { stagePrPublishApproval } from "../src/pr-publish-approval.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const hosts = vi.hoisted(() => ({ byName: new Map<string, { onRequest(request: Request): Promise<Response> }>() }));
const mocks = vi.hoisted(() => ({ execute: vi.fn(), review: vi.fn(), destroy: vi.fn() }));
const identity = vi.hoisted(() => ({ user: "owner@example.test" as string | null }));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_namespace: unknown, name: string) => ({
    fetch: (request: Request) => {
      const host = hosts.byName.get(name);
      if (!host) throw new Error(`no orchestrator fixture for ${name}`);
      return host.onRequest(request);
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    messages: unknown[] = [];
    async addMessages() {}
    onStart() {}
    getTools() { return {}; }
    onRequest() { return new Response(null, { status: 404 }); }
    keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
    abortSubAgent() {}
    schedule() { return Promise.resolve({}); }
  },
}));
vi.mock("agents/agent-tools", () => ({
  agentTool: (cls: { name: string }) => ({ execute: cls.name === "ReviewerAgent" ? mocks.review : mocks.execute }),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => identity.user !== null,
  resolveUserId: async () => identity.user,
}));

const { default: worker } = await import("../src/index.js");
const { CodingOrchestrator } = await import("../src/agents/orchestrator.js");
const { handleDiscordMention } = await import("../src/discord-mentions.js");
type Orchestrator = InstanceType<typeof CodingOrchestrator>;

setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const ORIGIN = "https://shiba.test";
const APP_ID = "123456789012345678";
const GUILD = "222222222222222222";
const CHANNEL = "333333333333333333";
const BOT_USER = "444444444444444444";
const APPROVER = "555555555555555555";
const REQUESTER = "666666666666666666";
const REPO = "https://github.com/o/r";
const BOT_TOKEN = "fixture-bot-token-not-real";

interface DiscordCall { method: string; url: string; body: unknown; authorization: string | null }

function bucket(): R2Bucket {
  const stored = new Map<string, Uint8Array>();
  return {
    put: vi.fn(async (key: string, value: string | Uint8Array) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
      stored.set(key, bytes);
      return { key, size: bytes.byteLength };
    }),
    get: vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
  } as unknown as R2Bucket;
}

async function fixture() {
  const db = customAgentD1();
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("hex");
  const attachments = bucket();
  const env = {
    ...productionEnvStubs(),
    Sandbox: {},
    CodingOrchestrator: {},
    AGENT_AUDIT: db.database,
    ATTACHMENTS: attachments,
    GITHUB_TOKEN: "ghp_fixture_not_real",
    GITHUB_API_BASE: "http://127.0.0.1:8799",
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_APPROVERS: APPROVER,
    DASHBOARD_APPROVERS: "owner@example.test",
    DISCORD_CLIENT_ID: APP_ID,
    DISCORD_CLIENT_SECRET: "fixture-client-secret-not-real",
  } as Record<string, unknown>;

  const discord: DiscordCall[] = [];
  let guildNameServed = "Fixture Server";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "discord.com") return Response.json({ message: "not found" }, { status: 404 });
    const text = await request.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
    discord.push({ method: request.method, url: url.pathname, body, authorization: request.headers.get("authorization") });
    if (url.pathname === "/api/v10/oauth2/token") {
      return Response.json({ access_token: "installer-user-token", token_type: "Bearer", scope: "bot applications.commands", guild: { id: GUILD, name: guildNameServed } });
    }
    if (url.pathname.endsWith("/messages") && request.method === "POST") return Response.json({ id: String(9e17 + discord.length) });
    return Response.json({});
  }));

  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException() {}, props: {} };
  const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await worker.fetch(new Request(ORIGIN + path, init), env as never, ctx as never);
    await settle();
    return response;
  };
  const dashboard = (path: string, body?: unknown) => call(path, body === undefined ? {} : {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const status = async () => (await (await dashboard("/api/discord/installations")).json()) as DiscordConnectionStatus;
  const install = async (guildId?: string) => {
    const begun = await dashboard("/api/discord/installations/begin", guildId ? { guildId } : {});
    expect(begun.status).toBe(200);
    const authorize = new URL(((await begun.json()) as { authorizeUrl: string }).authorizeUrl);
    const callback = await call(`/api/discord/installations/callback?code=fixture-code&state=${authorize.searchParams.get("state")}&guild_id=${GUILD}&permissions=274877975552`);
    return { authorize, callback };
  };
  const interaction = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ application_id: APP_ID, token: "interaction-token", guild_id: GUILD, channel_id: CHANNEL, ...payload });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
    return call("/api/discord/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      body,
    });
  };
  const orchestrator = (name: string): Orchestrator => {
    const host = Object.assign(Object.create(CodingOrchestrator.prototype) as Orchestrator, {
      env, name, messages: [],
      ctx: { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } },
      state: { runs: [] },
      setState(state: never) { setStateLikeProduction(this, state); },
    });
    hosts.byName.set(name, host as never);
    return host;
  };
  return { env, db, discord, status, install, interaction, orchestrator, settle, call, setGuildName: (name: string) => { guildNameServed = name; } };
}

function wireHarness(env: Record<string, unknown>) {
  mocks.review.mockResolvedValue({ agent: "reviewer", status: "completed", summary: "Captured diff reviewed.", report: "The frozen task and captured diff were inspected.", findings: [] });
  mocks.execute.mockImplementation(async (text: string) => {
    const input = parseAgentToolInput([{ role: "user", text }]);
    const result: CodingTaskResult = {
      baseRevision: "a".repeat(40), status: "completed", exitCode: 0, stderrTail: "",
      changedFiles: ["README.md"], diff: "+# edited", files: [{ path: "README.md", content: "# edited\n", encoding: "utf8" }],
      summary: "Edited README.",
    };
    if (!input.publishPullRequest) return formatAgentResult(result);
    const publicationProposal = await stagePrPublishApproval(env as never, {
      ownerId: input.accessAgent!, runId: `agent-tool:${input.dispatchApprovalId}`,
      sandboxId: input.sandboxId, repoUrl: input.repoUrl, baseBranch: input.baseBranch, task: input.task, result,
    });
    return formatAgentResult({ ...result, publicationProposal });
  });
}

const channelPosts = (calls: DiscordCall[]) =>
  calls.filter((call) => call.method === "POST" && call.url === `/api/v10/channels/${CHANNEL}/messages`);

beforeEach(() => {
  identity.user = "owner@example.test";
  hosts.byName.clear();
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Discord journey (fixture, real Worker routes)", () => {
  it.each(["slash command", "bot mention"])("installs, queues a %s, and posts the result to the channel only after approval", async (source) => {
    const f = await fixture();
    wireHarness(f.env);
    const host = f.orchestrator(`discord:${CHANNEL}`);

    const before = await f.status();
    expect(before.configured).toEqual({ oauth: true, publicKey: true, botToken: true, approvers: 1 });
    expect(before.installations).toEqual([]);

    const { authorize, callback } = await f.install();
    expect(authorize.origin + authorize.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(authorize.searchParams.get("scope")).toBe("bot applications.commands");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/discord/installations/callback`);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/app/?view=integrations&discordInstall=connected&discordGuild=${GUILD}`);
    const exchange = f.discord.find((call) => call.url === "/api/v10/oauth2/token")!;
    expect(exchange.authorization).toMatch(/^Basic /);
    expect(f.discord.some((call) => call.url === "/api/v10/oauth2/token/revoke" && (call.body as Record<string, string>).token === "installer-user-token")).toBe(true);
    const registered = f.discord.find((call) => call.method === "PUT")!;
    expect(registered.url).toBe(`/api/v10/applications/${APP_ID}/guilds/${GUILD}/commands`);
    expect(registered.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(JSON.stringify(f.db.sqlite.prepare("SELECT * FROM discord_installations").all())).not.toContain("installer-user-token");
    expect((await f.status()).installations).toMatchObject([{ guildId: GUILD, guildName: "Fixture Server", state: "active", commandsRegistered: true, lastError: null }]);

    f.discord.length = 0;
    if (source === "slash command") {
      const command = await f.interaction({
        id: "900000000000000001", type: 2, member: { user: { id: REQUESTER } },
        data: { name: "shiba", type: 1, options: [{ name: "task", value: "add a README" }, { name: "repo", value: REPO }] },
      });
      expect(await command.json()).toEqual({ type: 5 });
    } else {
      const mention = await handleDiscordMention(f.env as never, {
        id: "900000000000000001", channel_id: CHANNEL, guild_id: GUILD,
        content: `<@${BOT_USER}> add a README ${REPO}`,
        author: { id: REQUESTER }, mentions: [{ id: BOT_USER }],
      }, BOT_USER, { seen: async () => false });
      expect(mention.outcome).toBe("queued");
    }
    const card = (source === "slash command"
      ? f.discord.find((call) => call.method === "PATCH" && call.url === `/api/v10/webhooks/${APP_ID}/interaction-token/messages/@original`)
      : channelPosts(f.discord)[0])!;
    const cardBody = card.body as { content: string; components: Array<{ components: Array<{ custom_id: string; label: string }> }> };
    expect(cardBody.content).toContain("Approval requested");
    expect(cardBody.content).toContain("Task: add a README");
    expect(cardBody.components[0]!.components.map((button) => button.label)).toEqual(["Approve", "Reject"]);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(host.state.runs).toHaveLength(0);

    const approveId = cardBody.components[0]!.components[0]!.custom_id;
    const intruder = await f.interaction({
      id: "900000000000000002", type: 3, member: { user: { id: REQUESTER } },
      message: { id: "1", content: cardBody.content }, data: { custom_id: approveId, component_type: 2 },
    });
    expect(((await intruder.json()) as { data: { content: string } }).data.content).toBe("You are not on the approver list.");
    expect(mocks.execute).not.toHaveBeenCalled();

    f.discord.length = 0;
    const approve = await f.interaction({
      id: "900000000000000003", type: 3, member: { user: { id: APPROVER } },
      message: { id: "1", content: cardBody.content }, data: { custom_id: approveId, component_type: 2 },
    });
    expect(await approve.json()).toEqual({ type: 6 });
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled());
    expect(parseAgentToolInput([{ role: "user", text: String(mocks.execute.mock.calls[0]![0]) }]).task).toContain("add a README");
    await vi.waitFor(() => expect(host.state.runs.find((run) => run.status === "completed")).toBeTruthy());
    await f.settle();
    const retired = f.discord.find((call) => call.method === "PATCH")!;
    expect((retired.body as { components: unknown[]; content: string }).components).toEqual([]);
    expect((retired.body as { content: string }).content).toContain(`Approved by <@${APPROVER}>`);
    await vi.waitFor(() => expect(channelPosts(f.discord).length).toBeGreaterThan(0));
    const posted = channelPosts(f.discord).map((call) => (call.body as { content: string }).content).join("\n");
    expect(posted).toContain("Edited README.");
    expect(posted).not.toMatch(/failed/i);
    for (const post of channelPosts(f.discord)) {
      expect(post.authorization).toBe(`Bot ${BOT_TOKEN}`);
      expect((post.body as { allowed_mentions: unknown }).allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("turns a bot mention into an in-channel approval card and a denial starts nothing", async () => {
    const f = await fixture();
    wireHarness(f.env);
    const host = f.orchestrator(`discord:${CHANNEL}`);
    await f.install();
    f.discord.length = 0;

    const outcome = await handleDiscordMention(f.env as never, {
      id: "910000000000000001", channel_id: CHANNEL, guild_id: GUILD,
      content: `<@${BOT_USER}> add a README ${REPO}`, author: { id: REQUESTER },
      mentions: [{ id: BOT_USER }],
    }, BOT_USER, { seen: async () => false });
    expect(outcome.outcome).toBe("queued");
    const card = channelPosts(f.discord)[0]!;
    const cardBody = card.body as { content: string; message_reference: { message_id: string }; components: Array<{ components: Array<{ custom_id: string }> }> };
    expect(cardBody.message_reference.message_id).toBe("910000000000000001");
    expect(cardBody.content).toContain("Task: add a README");
    expect(cardBody.content).not.toContain(BOT_USER);
    expect(mocks.execute).not.toHaveBeenCalled();

    const reject = await f.interaction({
      id: "910000000000000002", type: 3, member: { user: { id: APPROVER } },
      message: { id: "2", content: cardBody.content }, data: { custom_id: cardBody.components[0]!.components[1]!.custom_id, component_type: 2 },
    });
    expect(await reject.json()).toEqual({ type: 6 });
    await f.settle();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(host.state.runs).toHaveLength(0);
    expect(f.discord.some((call) => call.method === "PATCH" && JSON.stringify(call.body).includes("Rejected by"))).toBe(true);
  });

  it("queues the Run with Shiba message command from the target message's text", async () => {
    const f = await fixture();
    const host = f.orchestrator(`discord:${CHANNEL}`);
    await f.install();
    f.discord.length = 0;
    const target = "930000000000000009";
    const response = await f.interaction({
      id: "930000000000000001", type: 2, member: { user: { id: REQUESTER } },
      data: { name: "Run with Shiba", type: 3, target_id: target, resolved: { messages: { [target]: { content: `<@${BOT_USER}> fix the flaky login test ${REPO}` } } } },
    });
    expect(await response.json()).toEqual({ type: 5 });
    const card = f.discord.find((call) => call.method === "PATCH")!;
    expect((card.body as { content: string }).content).toContain("Task: fix the flaky login test");
    expect(host.state.runs).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("disconnect makes the bot leave and stops answering; reconnect restores it", async () => {
    const f = await fixture();
    f.orchestrator(`discord:${CHANNEL}`);
    await f.install();
    f.discord.length = 0;

    const disconnected = await f.call(`/api/discord/installations/${GUILD}/disconnect`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}",
    });
    expect(disconnected.status).toBe(200);
    expect(((await disconnected.json()) as DiscordConnectionStatus).installations[0]).toMatchObject({ state: "disconnected", lastError: null });
    expect(f.discord).toMatchObject([{ method: "DELETE", url: `/api/v10/users/@me/guilds/${GUILD}`, authorization: `Bot ${BOT_TOKEN}` }]);

    const blocked = await f.interaction({
      id: "920000000000000001", type: 2, member: { user: { id: REQUESTER } },
      data: { name: "shiba", type: 1, options: [{ name: "task", value: "x" }, { name: "repo", value: REPO }] },
    });
    expect(((await blocked.json()) as { data: { content: string } }).data.content).toMatch(/disconnected from Shiba/);
    const mention = await handleDiscordMention(f.env as never, {
      id: "920000000000000002", channel_id: CHANNEL, guild_id: GUILD, content: `<@${BOT_USER}> x ${REPO}`,
      author: { id: REQUESTER }, mentions: [{ id: BOT_USER }],
    }, BOT_USER, { seen: async () => false });
    expect(mention.outcome).toBe("rejected");

    f.setGuildName("Renamed Server");
    const { authorize, callback } = await f.install(GUILD);
    expect(authorize.searchParams.get("guild_id")).toBe(GUILD);
    expect(authorize.searchParams.get("disable_guild_select")).toBe("true");
    expect(callback.headers.get("location")).toContain("discordInstall=connected");
    expect((await f.status()).installations).toMatchObject([{ guildId: GUILD, guildName: "Renamed Server", state: "active" }]);
    const resumed = await f.interaction({
      id: "920000000000000003", type: 2, member: { user: { id: REQUESTER } },
      data: { name: "shiba", type: 1, options: [{ name: "task", value: "x" }, { name: "repo", value: REPO }] },
    });
    expect(await resumed.json()).toEqual({ type: 5 });
  });

  it("rejects an unsigned interaction and an install callback from a different user or a replayed state", async () => {
    const f = await fixture();
    const unsigned = await f.call("/api/discord/interactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: 1 }) });
    expect(unsigned.status).toBe(401);

    const begun = await (await f.call("/api/discord/installations/begin", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).json() as { authorizeUrl: string };
    const state = new URL(begun.authorizeUrl).searchParams.get("state");
    identity.user = "someone-else@example.test";
    const stolen = await f.call(`/api/discord/installations/callback?code=c&state=${state}&guild_id=${GUILD}`);
    expect(stolen.headers.get("location")).toContain("discordInstall=failed");
    identity.user = "owner@example.test";
    const replay = await f.call(`/api/discord/installations/callback?code=c&state=${state}&guild_id=${GUILD}`);
    expect(replay.headers.get("location")).toContain("discordInstall=failed");
    expect(f.discord.some((call) => call.url === "/api/v10/oauth2/token")).toBe(false);

    const denied = await (await f.call("/api/discord/installations/begin", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).json() as { authorizeUrl: string };
    const deniedState = new URL(denied.authorizeUrl).searchParams.get("state");
    const cancelled = await f.call(`/api/discord/installations/callback?error=access_denied&state=${deniedState}`);
    expect(cancelled.headers.get("location")).toContain("discordInstall=denied");
    expect((await f.status()).installations).toEqual([]);
  });
});
