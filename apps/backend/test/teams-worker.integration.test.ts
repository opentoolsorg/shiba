import type { UIMessage } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { formatAgentResult, parseAgentToolInput } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
  execute: vi.fn(),
  destroy: vi.fn(async () => {}),
}));
vi.mock("agents/routing", () => ({ getAgentByName: mocks.getAgentByName, routeAgentRequest: vi.fn(async () => null) }));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    messages?: UIMessage[];
    async addMessages(messages: UIMessage[]) { this.messages = [...(this.messages ?? []), ...messages]; }
    onStart() {}
    getTools() { return {}; }
    schedule() { return Promise.resolve({}); }
    keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
    onRequest() { return new Response(null, { status: 404 }); }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const ORIGIN = "https://shiba.teams-fixture.test";
const APP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const APPROVER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SERVICE = "https://smba.trafficmanager.net/emea/";
const CONVERSATION = "19:fixture@thread.tacv2;messageid=100";
const CLIENT_SECRET = "fixture-teams-client-secret";
const BOT_TOKEN = "fixture-teams-connector-token";
const OWNER = "native-owner@example.test";
const REPO = "https://github.com/fixture/example";
const VERIFY_TEXT = "Fixture harness verified the README.";
const b64 = (value: string | ArrayBuffer) => Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)).toString("base64url");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("fixture: verifies Teams install, approval, execution, exact conversation result, and reconnect at Worker ingress", async () => {
  const d1 = customAgentD1();
  try {
    const prepare = (sql: string, values: unknown[] = []) => ({
      bind: (...params: unknown[]) => prepare(sql, params),
      async all() {
        const results = d1.sqlite.prepare(sql).all(...values.map((value) => value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value ?? null) as never[]);
        const changes = Number(d1.sqlite.prepare("SELECT changes() AS changes").get()?.changes);
        return { results, success: true, meta: { changes } };
      },
      async run() { return this.all(); },
      async first() { return (await this.all()).results[0] ?? null; },
    });
    const env = {
      ...productionEnvStubs(),
      AGENT_AUDIT: {
        exec: (sql: string) => d1.sqlite.exec(sql),
        prepare,
        async batch(statements: ReturnType<typeof prepare>[]) {
          const results = [];
          d1.sqlite.exec("BEGIN IMMEDIATE");
          try {
            for (const statement of statements) results.push(await statement.all());
            d1.sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            d1.sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      },
      BETTER_AUTH_SECRET: "fixture-auth-secret".repeat(4), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_OWNER_EMAIL: OWNER,
      BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-bootstrap",
      GITHUB_TOKEN: "fixture-github-token", Sandbox: {},
      SHIBA_VERIFY_STANDIN: "1",
      TEAMS_APP_ID: APP_ID, TEAMS_APP_PASSWORD: CLIENT_SECRET, TEAMS_APP_TENANT_ID: TENANT, TEAMS_APPROVERS: APPROVER,
    } as unknown as Env;
    const instances = new Map<string, CodingOrchestrator>();
    const deliveries = new Set<string>();
    env.Automations = {
      idFromName: () => "fixture-automations",
      get: () => ({ async fetch(req: Request) {
        const { key } = await req.json() as { key: string };
        const seen = deliveries.has(key);
        deliveries.add(key);
        return Response.json({ seen });
      } }),
    } as unknown as Env["Automations"];
    env.CodingOrchestrator = {} as Env["CodingOrchestrator"];
    mocks.getAgentByName.mockImplementation(async (namespace: unknown, name: string) => {
      if (namespace !== env.CodingOrchestrator) throw new Error("Unexpected fixture DO");
      let instance = instances.get(name);
      if (!instance) {
        instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
          name, env, messages: [], state: { runs: [] },
          setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
        });
        instances.set(name, instance);
      }
      return { fetch: instance.onRequest.bind(instance) };
    });
    mocks.execute.mockImplementation(async (text: string) => {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(BOT_TOKEN);
      const input = parseAgentToolInput([{ role: "user", text }]);
      expect(input).toMatchObject({ repoUrl: REPO, task: "Verify the README", publishPullRequest: false });
      return formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: VERIFY_TEXT });
    });
    const keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const key = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const outbound: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    let denyToken = false;
    vi.stubGlobal("fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(target instanceof Request ? target.url : target);
      if (url.origin === "https://login.botframework.com") {
        expect(init?.redirect).toBe("manual");
        if (url.pathname === "/v1/.well-known/openidconfiguration") {
          return Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
        }
        expect(url.pathname).toBe("/v1/.well-known/keys");
        return Response.json({ keys: [{ ...key, kid: "teams-worker-fixture", use: "sig", endorsements: ["msteams"] }] });
      }
      if (url.origin === "https://login.microsoftonline.com") {
        expect(init?.redirect).toBe("manual");
        expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/token`);
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
          grant_type: "client_credentials", client_id: APP_ID, client_secret: CLIENT_SECRET, scope: "https://api.botframework.com/.default",
        });
        return denyToken ? Response.json({}, { status: 401 }) : Response.json({ access_token: BOT_TOKEN, expires_in: 3600 });
      }
      if (url.origin === new URL(SERVICE).origin) {
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${BOT_TOKEN}`);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(JSON.stringify(body)).not.toContain(BOT_TOKEN);
        expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
        outbound.push({ path: url.pathname, method: init?.method ?? "GET", body });
        return Response.json({ id: `bot-${outbound.length}` });
      }
      throw new Error(`Unmocked fixture network origin: ${url.origin}`);
    });
    async function jwt(aud = APP_ID) {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${b64(JSON.stringify({ alg: "RS256", kid: "teams-worker-fixture" }))}.${b64(JSON.stringify({
        iss: "https://api.botframework.com", aud, exp: now + 300, nbf: now - 10, serviceUrl: SERVICE,
      }))}`;
      return `${unsigned}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned)))}`;
    }
    const bearer = await jwt();
    const send = (path: string, body?: Record<string, unknown>, headers?: Record<string, string>) => worker.fetch(new Request(ORIGIN + path, {
      method: body ? "POST" : "GET",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    const conversation = { id: CONVERSATION, conversationType: "channel", tenantId: TENANT };
    const activity = (id: string, fields: Record<string, unknown> = {}) => ({
      id, type: "message", channelId: "msteams", serviceUrl: SERVICE, conversation,
      from: { id: "29:approver", aadObjectId: APPROVER, name: "Verified human" },
      recipient: { id: "28:fixture-bot" }, ...fields,
    });
    const message = (id: string) => activity(id, {
      text: `<at>Shiba</at> ${REPO} Verify the README`,
      entities: [{ type: "mention", mentioned: { id: "28:fixture-bot" } }],
    });
    const deliver = (body: Record<string, unknown>, token = bearer) =>
      send("/api/teams/messages", body, token ? { Authorization: `Bearer ${token}` } : undefined);
    const actor = await send("/api/auth/sign-up/email", { name: "Owner", email: OWNER, password: "fixture-owner-password" }, { "x-shiba-bootstrap-token": "fixture-bootstrap" });
    expect(actor.status, await actor.clone().text()).toBe(200);
    d1.sqlite.prepare('UPDATE "user" SET emailVerified=1 WHERE email=?').run(OWNER);
    const signedIn = await send("/api/auth/sign-in/email", { email: OWNER, password: "fixture-owner-password" });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    expect(cookie).not.toBe("");
    const workspace = await createTeamWorkspace(env, OWNER, { name: "Teams fixture" });
    env.TEAMS_WORKSPACE_ID = workspace.workspaceId;
    const dashboard = (action?: string, headers?: Record<string, string>) => send(
      "/api/teams/connection", action ? { action } : undefined,
      { Cookie: cookie, "X-Shiba-Workspace": workspace.workspaceId, ...headers },
    );

    expect((await send("/api/teams/connection")).status).toBe(401);
    expect((await dashboard("connect", { Origin: "https://elsewhere.example.test" })).status).toBe(403);
    expect(await (await dashboard()).json()).toEqual({ status: "disconnected", installed: false });
    denyToken = true;
    expect((await dashboard("connect")).status).toBe(502);
    expect(await (await dashboard()).json()).toEqual({ status: "disconnected", installed: false });
    denyToken = false;
    expect(await (await dashboard("connect")).json()).toEqual({ status: "connected", installed: false });

    const installation = activity("install-1", { type: "installationUpdate", action: "add", timestamp: new Date().toISOString() });
    expect((await deliver(installation, "")).status).toBe(401);
    expect((await deliver(installation, await jwt(OTHER_TENANT))).status).toBe(401);
    expect((await deliver({ ...installation, conversation: { ...conversation, tenantId: OTHER_TENANT } })).status).toBe(403);
    expect(await (await dashboard()).json()).toEqual({ status: "connected", installed: false });
    expect((await deliver(installation)).status).toBe(200);
    expect(await (await dashboard()).json()).toEqual({ status: "connected", installed: true });

    async function card(id: string) {
      expect((await deliver(message(id))).status).toBe(200);
      const sent = outbound.at(-1)!;
      const path = `/emea/v3/conversations/${encodeURIComponent(CONVERSATION)}/activities/${id}`;
      expect(sent).toMatchObject({ path, method: "POST", body: { replyToId: id, conversation: { id: CONVERSATION, tenantId: TENANT } } });
      const attachments = sent.body.attachments as Array<{ content: { body: Array<{ text: string }>; actions: Array<{ type: string; data: { shiba: string } }> } }>;
      expect(attachments[0]!.content.body[0]!.text).toContain("Task: Verify the README");
      expect(attachments[0]!.content.actions.map((action) => action.type)).toEqual(["Action.Submit", "Action.Submit"]);
      return { path, approve: attachments[0]!.content.actions[0]!.data, reject: attachments[0]!.content.actions[1]!.data, id: `bot-${outbound.length}` };
    }
    const first = await card("mention-1");
    expect(instances.size).toBe(1);
    const host = [...instances.values()][0]!;
    expect(host.state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(host.state.tasks).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    await deliver(message("mention-1"));
    expect(outbound).toHaveLength(1);
    await deliver(activity("foreign-user", { value: first.approve, from: { id: "29:other", aadObjectId: OTHER_TENANT } }));
    expect(mocks.execute).not.toHaveBeenCalled();
    await deliver(activity("foreign-thread", { value: first.approve, conversation: { ...conversation, id: "19:other@thread.tacv2" } }));
    expect(mocks.execute).not.toHaveBeenCalled();
    await deliver(activity("click-1", { value: first.approve, replyToId: first.id }));
    await vi.waitFor(() => expect(host.state.runs[0]?.status).toBe("completed"));
    await vi.waitFor(() => expect(outbound).toContainEqual(expect.objectContaining({
      path: first.path, method: "POST", body: expect.objectContaining({ replyToId: "mention-1", text: expect.stringContaining(VERIFY_TEXT) }),
    })));
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const denied = await card("mention-2");
    await deliver(activity("click-2", { value: denied.reject, replyToId: denied.id }));
    expect([...instances.values()].at(-1)?.state.pendingApprovals?.[0]?.status).toBe("rejected");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const stale = await card("mention-3");
    expect(await (await dashboard("disconnect")).json()).toEqual({ status: "disconnected", installed: true });
    await deliver(message("disabled-message"));
    expect(instances.size).toBe(3);
    expect(await (await dashboard("connect")).json()).toEqual({ status: "connected", installed: true });
    await deliver(activity("stale-click", { value: stale.approve }));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const reconnected = await card("mention-4");
    await deliver(activity("click-4", { value: reconnected.approve, replyToId: reconnected.id }));
    await vi.waitFor(() => expect(outbound).toContainEqual(expect.objectContaining({
      path: reconnected.path, body: expect.objectContaining({ text: expect.stringContaining(VERIFY_TEXT) }),
    })));
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    await deliver({ ...installation, id: "install-2", action: "remove", timestamp: new Date(Date.parse(String(installation.timestamp)) + 1000).toISOString() });
    expect(await (await dashboard()).json()).toEqual({ status: "connected", installed: false });
    await deliver(installation);
    expect(await (await dashboard()).json()).toEqual({ status: "connected", installed: false });
  } finally {
    d1.sqlite.close();
  }
}, 20_000);
