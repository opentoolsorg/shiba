import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Env } from "../src/env.js";
import { createToken, type TokenRecord } from "../src/agent-tokens.js";
import { beginGmailConnect, decryptGmailToken, disconnectGmail, encryptGmailToken,
  finishGmailConnect, GMAIL_BASE, GMAIL_SCOPE, gmailStatus, grantGmail, readGmail,
  revokeGmailGrant, searchGmail } from "../src/gmail.js";
import { gmailOwner, handleGmail } from "../src/gmail-routes.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerGmailTools } from "../src/mcp-gmail-tools.js";
import { ORCHESTRATOR_PRINCIPAL } from "../src/codemode.js";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("../src/better-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/better-auth.js")>(),
  ensureBetterAuthSchema: vi.fn(),
  betterAuthFor: () => ({ api: { getSession: session } }),
  resolveBetterAuthUserId: async () => (await session())?.user?.email ?? null,
}));

const BASE = "https://shiba.test";
const KEY = "a1".repeat(32);
const OWNER = '["better-auth","stable-user-id"]';
const PEER = '["better-auth","peer-user-id"]';
const REFRESH = "secret-google-refresh-token";
const ACCESS = "secret-google-access-token";
const reader: TokenRecord = { principal: "dedicated-reader", scopes: ["gmail:read"], created: 1, revoked: false };

/** SQLite-backed D1 mock, including atomic batch and single-use UPDATE RETURNING. */
function database() {
  const sql = new DatabaseSync(":memory:");
  const prepared = (query: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepared(query, values),
    run: async () => {
      const result = sql.prepare(query).run(...params as never[]);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    all: async () => {
      const before = Number(sql.prepare("SELECT total_changes() AS n").get()!.n);
      const results = sql.prepare(query).all(...params as never[]);
      const changes = Number(sql.prepare("SELECT total_changes() AS n").get()!.n) - before;
      return { success: true, results, meta: { changes } };
    },
    first: async () => sql.prepare(query).get(...params as never[]) ?? null,
  });
  const d1 = {
    prepare: prepared,
    async batch(statements: { all: () => Promise<unknown> }[]) {
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sql.exec("COMMIT");
        return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { d1, sql };
}
function environment() {
  const { d1, sql } = database();
  const kv = new Map<string, string>();
  const env = {
    AGENT_AUDIT: d1,
    AGENT_TOKENS: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      list: async () => ({ keys: [...kv.keys()].map((name) => ({ name })), list_complete: true }),
    },
    BETTER_AUTH_SECRET: "b".repeat(32),
    GMAIL_CLIENT_ID: "owner-configured-client",
    GMAIL_CLIENT_SECRET: "owner-configured-secret",
    GMAIL_REDIRECT_URI: `${BASE}${GMAIL_BASE}/callback`,
    GMAIL_TOKEN_KEY: KEY,
  } as unknown as Env;
  return { env, sql };
}
function request(path: string, method = "GET", body?: unknown, origin = BASE) {
  return new Request(`${BASE}${GMAIL_BASE}${path}`, { method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function signIn(id = "stable-user-id", email = "owner@example.test") {
  session.mockResolvedValue({ user: { id, email } });
}

function mockGoogle(overrides: { scope?: string; refresh?: boolean; revoke?: boolean | "throw"; body?: string } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      expect(init?.method).toBe("POST");
      const params = new URLSearchParams(init?.body as URLSearchParams);
      expect(params.get("client_secret")).toBe("owner-configured-secret");
      return Response.json({ access_token: ACCESS, token_type: "Bearer", scope: overrides.scope ?? GMAIL_SCOPE,
        ...(overrides.refresh === false ? {} : { refresh_token: REFRESH }) });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      expect(init?.method).toBe("POST");
      expect(new URLSearchParams(init?.body as URLSearchParams).get("token")).toBe(REFRESH);
      if (overrides.revoke === "throw") throw new Error(REFRESH);
      return new Response(null, { status: overrides.revoke === false ? 500 : 200 });
    }
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(init?.redirect).toBe("error");
    if (url.pathname === "/gmail/v1/users/me/profile") return Response.json({ emailAddress: "mailbox@example.test" });
    if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [{ id: "abc123", threadId: "def456" }] });
    if (url.pathname === "/gmail/v1/users/me/messages/abc123") {
      const text = overrides.body ?? "untrusted mail https://127.0.0.1/private";
      return Response.json({ id: "abc123", threadId: "def456", snippet: "untrusted snippet", payload: {
        mimeType: "text/plain", headers: [{ name: "Subject", value: "untrusted subject" }],
        body: { data: Buffer.from(text).toString("base64url") },
      } });
    }
    throw new Error(`Unexpected mocked URL: ${url.origin}${url.pathname}`);
  });
}
async function connect(env: Env, owner = OWNER) {
  const start = await beginGmailConnect(env, owner);
  const state = new URL(start.authorizationUrl).searchParams.get("state")!;
  return finishGmailConnect(env, owner, state, "mock-code");
}
/** Mints `reader`'s token (same principal + created), returning the raw bearer. */
async function mintReader(env: Env) {
  return (await createToken(env, reader.principal, ["gmail:read"], reader.created)).token;
}
async function connectAndGrant(env: Env, owner = OWNER) {
  const connection = await connect(env, owner);
  await grantGmail(env, owner, await mintReader(env));
  return connection;
}

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(null);
  // There are no live Google/mail requests: every external call must match a mock.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external HTTP"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Gmail owner-only route boundary", () => {
  it("rejects anonymous loopback, email headers, API keys and agent bearers without an owner", async () => {
    const { env } = environment();
    for (const headers of [{}, { "CF-Access-Authenticated-User-Email": "forged@example.test" },
      { authorization: "Bearer shb_forged" }, { "x-api-key": "forged" }] as Record<string, string>[]) {
      const res = await handleGmail(new Request(`http://localhost${GMAIL_BASE}`, { headers }), { ...env, BETTER_AUTH_SECRET: undefined });
      expect(res?.status).toBe(401);
    }
    expect(await gmailOwner(request(""), { ...env, REQUIRE_ACCESS: "1" })).toBeNull();
    expect(await gmailOwner(request(""), { ...env, ACCESS_AUD: "aud" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses session user.id, not mutable email, with separate owners and no default", async () => {
    const { env } = environment();
    signIn();
    expect(await gmailOwner(request(""), env)).toBe(OWNER);
    signIn("stable-user-id", "changed@example.test");
    expect(await gmailOwner(request(""), env)).toBe(OWNER);
    signIn("peer-user-id", "changed@example.test");
    expect(await gmailOwner(request(""), env)).toBe(PEER);
    session.mockResolvedValue({ user: { email: "owner@example.test" } });
    expect((await handleGmail(request(""), env))?.status).toBe(401);
  });

  it("requires verified Access subject and namespaces issuer/audience", async () => {
    const { env } = environment();
    signIn(); // Access mode does not silently fall back to Better Auth/email.
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "gmail-owner-key", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://gmail-owner-team.cloudflareaccess.com/cdn-cgi/access/certs");
      return Response.json({ keys: [jwk] });
    }));
    const issuer = "https://gmail-owner-team.cloudflareaccess.com";
    async function signed(sub?: string, aud = "gmail-aud", email = "same@example.test") {
      return new SignJWT({ email, ...(sub ? { sub } : {}) }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    }
    const accessRequest = (token: string) => new Request(`${BASE}${GMAIL_BASE}`, {
      headers: { "Cf-Access-Jwt-Assertion": token, "CF-Access-Authenticated-User-Email": "forged@example.test" },
    });
    const accessEnv = { ...env, ACCESS_AUD: "gmail-aud" };
    expect(await gmailOwner(accessRequest(await signed()), accessEnv)).toBeNull();
    expect(await gmailOwner(accessRequest(await signed("subject", "wrong-aud")), accessEnv)).toBeNull();
    expect(await gmailOwner(accessRequest(await signed("subject")), accessEnv)).toBe(JSON.stringify(["access", issuer, "gmail-aud", "subject"]));
    expect(await gmailOwner(accessRequest(await signed("subject", "gmail-aud", "changed@example.test")), accessEnv))
      .toBe(JSON.stringify(["access", issuer, "gmail-aud", "subject"]));
    expect(await gmailOwner(accessRequest("invalid.jwt"), accessEnv)).toBeNull();
  });

  it("bounds grant request bytes before buffering, including streamed multibyte bodies", async () => {
    const { env } = environment();
    signIn();
    for (const body of [{ principal: "x".repeat(1100) }, { principal: "é".repeat(600) }]) {
      expect((await handleGmail(request("/grants", "POST", body), env))?.status).toBe(400);
    }
    const canceled = vi.fn();
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk++;
        controller.enqueue(new Uint8Array(600).fill(0x61));
      }, cancel: canceled,
    });
    const streamed = new Request(`${BASE}${GMAIL_BASE}/grants`, { method: "POST", body: stream,
      headers: { origin: BASE }, duplex: "half" } as RequestInit);
    expect((await handleGmail(streamed, env))?.status).toBe(400);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(chunk).toBeLessThanOrEqual(3); // one prefetch is permitted by ReadableStream.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("OAuth denial cancels only the pending flow; Access without ACCESS_AUD explains its 503", async () => {
    const { env } = environment();
    signIn();
    const start = await beginGmailConnect(env, OWNER);
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect((await handleGmail(request(`/callback?error=access_denied&state=${state}`), env))?.status).toBe(400);
    await expect(beginGmailConnect(env, OWNER)).resolves.toHaveProperty("authorizationUrl");
    const res = await handleGmail(request(""), { ...env, REQUIRE_ACCESS: "1" });
    expect(res?.status).toBe(503);
    expect(await res!.json()).toEqual({ error: "Gmail requires ACCESS_AUD when Cloudflare Access is enabled." });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed without config and enforces same-origin and exact grant payload", async () => {
    const { env } = environment();
    signIn();
    const missing = { ...env, GMAIL_TOKEN_KEY: undefined };
    expect(await (await handleGmail(request(""), missing))!.json()).toEqual({ configured: false, connection: null, grants: [] });
    expect((await handleGmail(request("/connect", "POST"), missing))?.status).toBe(503);
    expect((await handleGmail(request("/connect", "POST", undefined, "https://evil.test"), env))?.status).toBe(403);
    expect((await handleGmail(request("/grants", "POST", { token: "shb_x", owner: PEER }), env))?.status).toBe(400);
    for (const redirect of ["https://evil.test/other", `${BASE}${GMAIL_BASE}/callback?next=evil`, "http://public.test/api/connections/gmail/callback"]) {
      expect((await handleGmail(request("/connect", "POST"), { ...env, GMAIL_REDIRECT_URI: redirect }))?.status).toBe(503);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Gmail OAuth state, scopes and encrypted storage", () => {
  it("allows only one pending owner flow and disconnect invalidates in-flight callback persistence", async () => {
    const { env, sql } = environment();
    const start = await beginGmailConnect(env, OWNER);
    await expect(beginGmailConnect(env, OWNER)).rejects.toThrow("already pending");
    const normal = mockGoogle();
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/profile")) { reached(); await waiting; }
      return normal(input, init);
    }));
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const finishing = finishGmailConnect(env, OWNER, state, "code");
    await entered;
    expect(await disconnectGmail(env, OWNER)).toEqual({ disconnected: true, revoke: "not_connected" });
    release();
    await expect(finishing).rejects.toThrow("connection changed");
    expect((await gmailStatus(env, OWNER)).connection).toBeNull();
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(0);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM gmail_oauth_states").get()!.n).toBe(0);
    expect(normal.mock.calls.some(([url]) => String(url) === "https://oauth2.googleapis.com/revoke")).toBe(true);
  });
  it("stores only state SHA-256, binds to owner, expires in 10 min, uses PKCE and fixed redirect", async () => {
    const { env, sql } = environment();
    const start = await beginGmailConnect(env, OWNER, 1000);
    const url = new URL(start.authorizationUrl);
    const state = url.searchParams.get("state")!;
    expect(start.expiresAt).toBe(601000);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(env.GMAIL_REDIRECT_URI);
    const stored = sql.prepare("SELECT * FROM gmail_oauth_states").get()!;
    expect(stored.owner).toBe(OWNER);
    expect(stored.state_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored.verifier as string))).toString("base64url"))
      .toBe(url.searchParams.get("code_challenge"));
    await expect(finishGmailConnect(env, PEER, state, "code", 1001)).rejects.toThrow("expired or already used");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM gmail_oauth_states").get()!.n).toBe(1);
    await expect(finishGmailConnect(env, OWNER, state, "code", 601000)).rejects.toThrow("expired or already used");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("atomically consumes state once under replay, reads only profile, and never stores/discloses raw tokens", async () => {
    const { env, sql } = environment();
    const google = mockGoogle();
    vi.stubGlobal("fetch", google);
    const start = await beginGmailConnect(env, OWNER);
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const results = await Promise.allSettled([
      finishGmailConnect(env, OWNER, state, "mock-code"), finishGmailConnect(env, OWNER, state, "mock-code"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const tokenCall = google.mock.calls.find(([url]) => String(url).endsWith("/token"))!;
    const params = new URLSearchParams(tokenCall[1]?.body as URLSearchParams);
    expect(params.get("code_verifier")).toHaveLength(43);
    expect(params.get("redirect_uri")).toBe(env.GMAIL_REDIRECT_URI);
    expect(google.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/token", "/gmail/v1/users/me/profile"]);
    const stored = sql.prepare("SELECT * FROM gmail_connections").get()!;
    const status = await gmailStatus(env, OWNER);
    for (const value of [stored, status, results]) {
      expect(JSON.stringify(value)).not.toContain(REFRESH);
      expect(JSON.stringify(value)).not.toContain(ACCESS);
    }
    expect(await decryptGmailToken(stored.refresh_cipher as string, KEY, OWNER, stored.id as string)).toBe(REFRESH);
    expect((await gmailStatus(env, PEER)).connection).toBeNull();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM gmail_oauth_states").get()!.n).toBe(0);
  });

  it.each(["", `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify`, "https://mail.google.com/"])("rejects non-exact granted scope %s", async (scope) => {
    const { env, sql } = environment();
    const google = mockGoogle({ scope });
    vi.stubGlobal("fetch", google);
    await expect(connect(env)).rejects.toThrow("exactly the read-only scope");
    // The rejected-but-issued grant is revoked at Google, never stored.
    expect(google.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/token", "/revoke"]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM gmail_connections").get()!.n).toBe(0);
  });

  it("requires refresh token, consumes failed exchanges, and rejects callback/provider errors without secrets", async () => {
    const { env } = environment();
    vi.stubGlobal("fetch", mockGoogle({ refresh: false }));
    const start = await beginGmailConnect(env, OWNER);
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await expect(finishGmailConnect(env, OWNER, state, "code")).rejects.toThrow("offline access");
    await expect(finishGmailConnect(env, OWNER, state, "code")).rejects.toThrow("already used");
    signIn();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(REFRESH); }));
    const next = await beginGmailConnect(env, OWNER);
    const nextState = new URL(next.authorizationUrl).searchParams.get("state")!;
    const response = await handleGmail(request(`/callback?code=code&state=${nextState}`), env);
    expect(response?.status).toBe(502);
    expect(await response!.text()).not.toContain(REFRESH);
    expect((await handleGmail(request(`/callback?error=${REFRESH}&state=${nextState}`), env))?.status).toBe(400);
  });

  it("AES-GCM random 12-byte IV binds both owner and connection in AAD and rejects tampering/key change", async () => {
    const first = await encryptGmailToken(REFRESH, KEY, OWNER, "connection-a");
    const second = await encryptGmailToken(REFRESH, KEY, OWNER, "connection-a");
    expect(first).not.toBe(second);
    expect(Buffer.from(first.split(".")[1]!, "base64url")).toHaveLength(12);
    expect(first).not.toContain(REFRESH);
    expect(await decryptGmailToken(first, KEY, OWNER, "connection-a")).toBe(REFRESH);
    for (const [cipher, key, owner, id] of [[first, KEY, PEER, "connection-a"], [first, KEY, OWNER, "connection-b"],
      [first, "b2".repeat(32), OWNER, "connection-a"], [first.slice(0, -3) + "aaa", KEY, OWNER, "connection-a"]]) {
      await expect(decryptGmailToken(cipher!, key!, owner!, id!)).rejects.toThrow("credentials unavailable");
    }
  });
});

describe("Gmail explicit grants, bounded tools, disconnect", () => {
  it("requires proof of a dedicated gmail:read token; a peer owner cannot claim, overwrite or revoke it", async () => {
    const { env } = environment();
    vi.stubGlobal("fetch", mockGoogle());
    await connect(env);
    await expect(grantGmail(env, OWNER, reader.principal)).rejects.toThrow("gmail:read scope");
    await expect(grantGmail(env, OWNER, `shb_${"0".repeat(16)}_${"0".repeat(48)}`)).rejects.toThrow("gmail:read scope");
    await expect(grantGmail(env, OWNER, (await createToken(env, "mail-only", ["email:read"])).token)).rejects.toThrow("gmail:read scope");
    for (const principal of ["orchestrator-agent", "default", "orchestrator", "system", "slack", "web:shared:default"]) {
      const { token } = await createToken(env, principal, ["gmail:read"]);
      await expect(grantGmail(env, OWNER, token)).rejects.toThrow("dedicated external agent");
    }
    const token = await mintReader(env);
    await expect(searchGmail(env, reader, "mail", 1)).rejects.toThrow("Explicit Gmail connection grant");
    // Principal names are enumerable (/api/agents); naming one is never enough.
    await connect(env, PEER);
    signIn("peer-user-id");
    expect((await handleGmail(request("/grants", "POST", { principal: reader.principal }), env))?.status).toBe(400);
    await grantGmail(env, OWNER, token);
    await expect(grantGmail(env, PEER, token)).rejects.toThrow("already granted elsewhere");
    await revokeGmailGrant(env, PEER, reader.principal);
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(1);
    expect((await searchGmail(env, reader, "mail", 1)).messages).toHaveLength(1);
    // A re-minted same-name token is a different credential and needs its own grant.
    await expect(searchGmail(env, { ...reader, created: reader.created + 1 }, "mail", 1)).rejects.toThrow("Explicit Gmail connection grant");
    // A peer's own token under the same default-style name grants independently.
    await grantGmail(env, PEER, (await createToken(env, reader.principal, ["gmail:read"], reader.created + 1)).token);
    expect((await gmailStatus(env, PEER)).grants).toHaveLength(1);
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(1);
    expect((await searchGmail(env, { ...reader, created: reader.created + 1 }, "mail", 1)).messages).toHaveLength(1);
    await revokeGmailGrant(env, PEER, reader.principal);
    await expect(searchGmail(env, { ...reader, scopes: ["email:read"] }, "mail", 1)).rejects.toThrow("missing scope");
    await expect(searchGmail(env, { ...reader, revoked: true }, "mail", 1)).rejects.toThrow("access denied");
    await revokeGmailGrant(env, OWNER, reader.principal);
    await expect(searchGmail(env, reader, "mail", 1)).rejects.toThrow("Explicit Gmail connection grant");
  });

  it("publishes read-only tools only externally, rejects unknown args/bounds/IDs before fetch, and audits no content", async () => {
    const { env, sql } = environment();
    const google = mockGoogle({ body: "é".repeat(25_000) });
    vi.stubGlobal("fetch", google);
    await connectAndGrant(env);
    const registry = createToolRegistry(env);
    registerGmailTools(registry);
    expect(registry.tools().map((tool) => [tool.name, tool.scope, tool.meta.annotations?.readOnlyHint]))
      .toEqual([["gmail_search", "gmail:read", true], ["gmail_read", "gmail:read", true]]);
    expect(ORCHESTRATOR_PRINCIPAL.scopes).not.toContain("gmail:read");
    google.mockClear();
    for (const [name, args] of [["gmail_search", { query: "x".repeat(257) }], ["gmail_search", { query: "x", limit: 26 }],
      ["gmail_search", { query: "x", owner: OWNER }], ["gmail_search", { query: "x", mailbox: "peer" }],
      ["gmail_read", { messageIds: Array(26).fill("abc123") }], ["gmail_read", { messageIds: ["../send"] }],
      ["gmail_read", { messageIds: ["abc123?alt=media"] }], ["gmail_read", { messageIds: [] }]] as const) {
      expect((await registry.invoke(name, args, reader)).isError).toBe(true);
    }
    expect(google).not.toHaveBeenCalled();
    expect((await registry.invoke("gmail_search", { query: "private-query", limit: 25 }, { ...reader, scopes: ["email:read"] })).isError).toBe(true);
    const searched = await registry.invoke("gmail_search", { query: "private-query", limit: 25 }, reader);
    expect(searched.isError).not.toBe(true);
    const read = await registry.invoke("gmail_read", { messageIds: ["abc123"] }, reader);
    expect(read.isError).not.toBe(true);
    const result = JSON.parse((read.content[0] as { text: string }).text);
    const content = result.messages[0].content;
    expect(content.security_notice).toContain("UNTRUSTED");
    const body = JSON.parse(content.untrusted).body;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(20 * 1024);
    expect(JSON.parse(content.untrusted).headers.subject).toBe("untrusted subject");
    const gmailCalls = google.mock.calls.filter(([url]) => new URL(String(url)).hostname === "gmail.googleapis.com");
    expect(gmailCalls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(new URL(String(gmailCalls[0]![0])).searchParams.get("maxResults")).toBe("25");
    expect(new URL(String(gmailCalls[0]![0])).searchParams.get("q")).toBe("private-query");
    const audit = JSON.stringify(sql.prepare("SELECT * FROM audit_log").all());
    for (const value of [REFRESH, ACCESS, "private-query", "untrusted subject", "é".repeat(100)]) expect(audit).not.toContain(value);
    expect(audit).toContain("gmail_read");
    // Owner lifecycle is audited too, by hashed subject only.
    expect(audit).toContain("gmail.connect");
    expect(audit).toContain("gmail.grant");
    expect(audit).toContain("missing scope");
  });

  it("accepts bounded opaque URL-safe message IDs but rejects separators/query injection", async () => {
    const { env } = environment();
    vi.stubGlobal("fetch", mockGoogle());
    await connectAndGrant(env);
    const id = "opaque-Mail_ID_Z".repeat(5);
    const normal = mockGoogle();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [{ id, threadId: "thread_Z-12" }] });
      if (url.pathname === `/gmail/v1/users/me/messages/${id}`) return Response.json({ id, payload: { mimeType: "text/plain", body: { data: "" } } });
      return normal(input, init);
    }));
    expect((await searchGmail(env, reader, "x", 1)).messages).toEqual([{ id, threadId: "thread_Z-12" }]);
    expect((await readGmail(env, reader, [id])).messages[0]?.id).toBe(id);
    for (const invalid of ["x".repeat(129), "a/b", "a?b", "a#b", "a%2fb", "..", ""]) {
      await expect(readGmail(env, reader, [invalid])).rejects.toThrow("valid Gmail message IDs");
    }
  });

  it("caps search responses, rejects excessive provider responses and widened refresh scope", async () => {
    const { env } = environment();
    vi.stubGlobal("fetch", mockGoogle());
    await connectAndGrant(env);
    const normal = mockGoogle();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/gmail/v1/users/me/messages") {
        return Response.json({ messages: Array(100).fill({ id: "abc123", threadId: "def456" }) });
      }
      return normal(input, init);
    }));
    expect((await searchGmail(env, reader, "x", 2)).messages).toHaveLength(2);
    const widened = mockGoogle({ scope: `${GMAIL_SCOPE} extra` });
    vi.stubGlobal("fetch", widened);
    await expect(searchGmail(env, reader, "x", 1)).rejects.toThrow("exactly the read-only scope");
    // A bad refresh response must not revoke (and silently kill) the stored grant.
    expect(widened.mock.calls.some(([url]) => String(url).endsWith("/revoke"))).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/messages/")) return new Response("x".repeat(512 * 1024 + 1));
      return normal(input, init);
    }));
    await expect(readGmail(env, reader, ["abc123"])).rejects.toThrow("provider request failed");
  });

  it("disables the connection and all grants before remote revoke finishes", async () => {
    const { env, sql } = environment();
    const normal = mockGoogle();
    vi.stubGlobal("fetch", normal);
    await connectAndGrant(env);
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://oauth2.googleapis.com/revoke") { reached(); await waiting; }
      return normal(input, init);
    });
    vi.stubGlobal("fetch", blocked);
    const disconnecting = disconnectGmail(env, OWNER);
    await entered;
    expect(sql.prepare("SELECT active FROM gmail_connections").get()!.active).toBe(0);
    expect((await gmailStatus(env, OWNER)).connection).toBeNull();
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(0);
    await expect(searchGmail(env, reader, "mail", 1)).rejects.toThrow("Explicit Gmail connection grant");
    await expect(grantGmail(env, OWNER, await mintReader(env))).rejects.toThrow("No connection");
    expect(blocked).toHaveBeenCalledTimes(1);
    release();
    expect((await disconnecting).revoke).toBe("revoked");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM gmail_connections").get()!.n).toBe(0);
  });

  it.each([true, false, "throw"] as const)("always removes local state and grants after revoke outcome %s", async (revoke) => {
    const { env, sql } = environment();
    vi.stubGlobal("fetch", mockGoogle({ revoke }));
    await connectAndGrant(env);
    const result = await disconnectGmail(env, OWNER);
    expect(result).toEqual({ disconnected: true, revoke: revoke === true ? "revoked" : "failed" });
    for (const table of ["gmail_connections", "gmail_grants", "gmail_oauth_states"]) {
      expect(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
    }
    await expect(searchGmail(env, reader, "mail", 1)).rejects.toThrow("Explicit Gmail connection grant");
    expect(await disconnectGmail(env, OWNER)).toEqual({ disconnected: true, revoke: "not_connected" });
  });

  it("rejects reconnect without losing existing connection/grants; allows explicit disconnect then reconnect", async () => {
    const { env } = environment();
    const google = mockGoogle();
    vi.stubGlobal("fetch", google);
    const original = await connectAndGrant(env);
    await disconnectGmail(env, PEER);
    google.mockClear();
    await expect(beginGmailConnect(env, OWNER)).rejects.toThrow("Disconnect the existing");
    expect(google).not.toHaveBeenCalled();
    expect((await gmailStatus(env, OWNER)).connection?.id).toBe(original.id);
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(1);
    await disconnectGmail(env, OWNER);
    await connect(env);
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(0);
    await grantGmail(env, OWNER, await mintReader(env));
    const result = await disconnectGmail({ ...env, GMAIL_CLIENT_SECRET: undefined, GMAIL_TOKEN_KEY: undefined }, OWNER);
    expect(result.revoke).toBe("failed");
    expect((await gmailStatus(env, OWNER)).connection).toBeNull();
    expect((await gmailStatus(env, OWNER)).grants).toHaveLength(0);
  });

  it("guards source against Gmail write endpoints/scopes and Code Mode registration", () => {
    const source = readFileSync(new URL("../src/gmail.ts", import.meta.url), "utf8") +
      readFileSync(new URL("../src/mcp-gmail-tools.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/gmail\.(?:modify|send|compose|insert|labels|settings)|https:\/\/mail\.google\.com/);
    expect(source).not.toMatch(/messages\/(?:send|batchModify|batchDelete|import|insert)|\/(?:trash|untrash|modify|drafts)(?:["'`/?]|$)/);
    expect(source).not.toMatch(/method:\s*["'](?:PUT|PATCH|DELETE)["']/);
    expect(readFileSync(new URL("../src/codemode.ts", import.meta.url), "utf8")).not.toContain("registerGmailTools");
    const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(entry.indexOf("!(await isAuthorizedRequest(request, env))")).toBeLessThan(entry.indexOf("await handleGmail(request, env)"));
  });
});
