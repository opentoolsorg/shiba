import { DatabaseSync } from "node:sqlite";
import { applyAuthMigrations } from "./fixtures/auth-migrations.js";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuthFor, ensureBetterAuthSchema, getSsoConfig, getSsoReadiness, isSsoEmailAllowed, handleBetterAuth, resolveBetterAuthUserId, type BetterAuthLaneEnv } from "../src/better-auth.js";

const BASE = "http://localhost:8787";
const credentials = {};
async function fixture(overrides: Partial<BetterAuthLaneEnv> = {}) {
  const sqlite = new DatabaseSync(":memory:");
  applyAuthMigrations(sqlite);
  const value = (v: unknown): never => (v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : v ?? null) as never;
  const prepared = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepared(sql, args),
    async all() { return { results: sqlite.prepare(sql).all(...params.map(value)), meta: {} }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...params.map(value)) ?? null; },
  });
  const db = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql),
    batch: async (statements: ReturnType<typeof prepared>[]) => Promise.all(statements.map(s => s.all())) } as unknown as D1Database;
  const env: BetterAuthLaneEnv = { AGENT_AUDIT: db, BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: BASE, ...credentials, ...overrides };
  await ensureBetterAuthSchema({ AGENT_AUDIT: db });
  const auth = await betterAuthFor(env);
  return { sqlite, db, env, auth };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (path: string, body: unknown) => new Request(`${BASE}/api/auth/${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body),
});
function seed(f: Fixture, verified = true, policy: "bootstrap" | "invited" | null = "bootstrap") {
  f.sqlite.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('local','Local','local@example.test',?,?,?)`)
    .run(Number(verified), Date.now(), Date.now());
  if (policy) f.sqlite.prepare(`INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id) VALUES('local','local@example.test',?,?,?)`)
    .run(policy, policy === "invited" ? "invitation" : null, policy === "invited" ? "workspace" : null);
}

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });

const GOOGLE_ISSUER = "https://accounts.google.com";
/** Serve a fixed public issuer's discovery document from the local fixture, offline. */
function routeIssuer(publicIssuer: string, origin: string) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${publicIssuer}/`)) return realFetch(input, init);
    return realFetch(`${origin}${url.slice(publicIssuer.length)}`, init);
  });
}

async function issuer(publicIssuer?: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let nonce = "", email = "local@example.test", badSignature = false;
  let tokenBody: URLSearchParams | undefined;
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") {
      response.end(JSON.stringify({ issuer: publicIssuer ?? origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`, id_token_signing_alg_values_supported: ["RS256"] }));
    } else if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }] }));
    } else if (request.url === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      tokenBody = new URLSearchParams(Buffer.concat(chunks).toString());
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: publicIssuer ?? origin, aud: "client", sub: "subject", email, email_verified: true,
        name: "Remote", nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })}`;
      const signature = Buffer.from(sign("RSA-SHA256", Buffer.from(payload), privateKey)).toString("base64url");
      response.end(JSON.stringify({ access_token: "fixture-access", token_type: "Bearer", expires_in: 300,
        id_token: `${payload}.${badSignature ? "invalid" : signature}` }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing issuer address");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, setClaims: (value: { nonce: string; email?: string; badSignature?: boolean }) => {
    nonce = value.nonce; email = value.email ?? email; badSignature = value.badSignature ?? false;
  }, tokenBody: () => tokenBody };
}

const complete = { SHIBA_SSO_ENABLED: "1", SSO_OIDC_ISSUER: "https://idp.example.test/tenant/", SSO_OIDC_CLIENT_ID: "client", SSO_OIDC_CLIENT_SECRET: "fixture-secret" };
describe("SSO configuration and domain policy", () => {
  it("requires the flag and complete settings", () => {
    expect(getSsoConfig({ ...complete, SHIBA_SSO_ENABLED: "0" }).enabled).toBe(false);
    expect(getSsoConfig({ SHIBA_SSO_ENABLED: "1" }).missing).toEqual(["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"]);
    expect(getSsoConfig(complete)).toMatchObject({ enabled: true, issuer: "https://idp.example.test/tenant", displayName: "Company SSO", autoJoin: false });
  });
  it.each(["http://idp.example.test", "https://user:password@idp.example.test", "https://idp.example.test?key=value", "broken"])("rejects invalid issuer %s", value => {
    expect(getSsoConfig({ ...complete, SSO_OIDC_ISSUER: value })).toMatchObject({ enabled: false, missing: ["SSO_OIDC_ISSUER"] });
  });
  it("keeps manual issuer mode as the default", () => {
    expect(getSsoConfig(complete)).toMatchObject({ preset: undefined, settings: ["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"],
      missing: [], conflicting: [] });
  });
  it("uses the opt-in Google Workspace preset issuer and display name", () => {
    const { SSO_OIDC_ISSUER: _issuer, ...preset } = complete;
    expect(getSsoConfig({ ...preset, SSO_OIDC_PRESET: " Google-Workspace " })).toMatchObject({ enabled: true, preset: "google-workspace",
      issuer: GOOGLE_ISSUER, displayName: "Google Workspace", missing: [], conflicting: [],
      settings: ["SSO_OIDC_PRESET", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"] });
    expect(getSsoConfig({ ...preset, SSO_OIDC_PRESET: "google-workspace", SSO_OIDC_DISPLAY_NAME: "Example Inc" }).displayName).toBe("Example Inc");
    expect(getSsoConfig({ ...complete, SSO_OIDC_PRESET: "google-workspace", SSO_OIDC_ISSUER: `${GOOGLE_ISSUER}/` })).toMatchObject({ enabled: true, issuer: GOOGLE_ISSUER });
  });
  it("rejects a preset that conflicts with an explicit issuer", () => {
    expect(getSsoConfig({ ...complete, SSO_OIDC_PRESET: "google-workspace" })).toMatchObject({ enabled: false, issuer: undefined,
      missing: [], conflicting: ["SSO_OIDC_PRESET", "SSO_OIDC_ISSUER"] });
  });
  it.each(["okta", "__proto__", "constructor"])("rejects unknown preset %s", value => {
    expect(getSsoConfig({ ...complete, SSO_OIDC_PRESET: value })).toMatchObject({ enabled: false, issuer: undefined, missing: ["SSO_OIDC_PRESET"] });
  });
  it("reports ready only when the auth lane will mount the handler", () => {
    const store = {} as D1Database;
    expect(getSsoReadiness(complete)).toMatchObject({ ready: false, missing: ["BETTER_AUTH_SECRET", "AGENT_AUDIT"] });
    expect(getSsoReadiness({ ...complete, BETTER_AUTH_SECRET: "short", AGENT_AUDIT: store })).toMatchObject({ ready: false, missing: ["BETTER_AUTH_SECRET"] });
    expect(getSsoReadiness({ ...complete, SHIBA_SSO_ENABLED: "0", BETTER_AUTH_SECRET: "s".repeat(32), AGENT_AUDIT: store })).toMatchObject({ ready: false, missing: [] });
    expect(getSsoReadiness({ ...complete, BETTER_AUTH_SECRET: "s".repeat(32), AGENT_AUDIT: store })).toEqual({ ready: true, preset: undefined, settings: ["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET", "BETTER_AUTH_SECRET", "AGENT_AUDIT"],
      missing: [], conflicting: [] });
  });
  it("matches exact normalized domains or the exact bootstrap owner email", () => {
    const env = { SSO_ALLOWED_DOMAINS: " example.test, OTHER.test ", BETTER_AUTH_OWNER_EMAIL: "owner@outside.test" };
    for (const email of ["person@EXAMPLE.test", "person@other.test", "OWNER@outside.test"]) expect(isSsoEmailAllowed(env, email)).toBe(true);
    for (const email of ["person@sub.example.test", "person@evil-example.test", "person@outside.test", "bad@@example.test", "@example.test"]) expect(isSsoEmailAllowed(env, email)).toBe(false);
    expect(isSsoEmailAllowed({}, "person@example.test")).toBe(false);
  });
  it("publishes only the display name and enabled state for configured SSO", async () => {
    const response = await handleBetterAuth(new Request(`${BASE}/api/auth/social-providers`), { ...complete,
      BETTER_AUTH_SECRET: "s".repeat(32), SSO_OIDC_DISPLAY_NAME: "Company Identity" });
    expect(await response?.json()).toEqual({ providers: { google: false, slack: false },
      sso: { enabled: true, displayName: "Company Identity" } });
  });
  it("publishes only the preset display name, never issuer or client values", async () => {
    const { SSO_OIDC_ISSUER: _issuer, ...preset } = complete;
    const response = await handleBetterAuth(new Request(`${BASE}/api/auth/social-providers`), { ...preset, SSO_OIDC_PRESET: "google-workspace",
      BETTER_AUTH_SECRET: "s".repeat(32) });
    const body = await response?.text() ?? "";
    expect(JSON.parse(body)).toEqual({ providers: { google: false, slack: false }, sso: { enabled: true, displayName: "Google Workspace" } });
    for (const value of [GOOGLE_ISSUER, "accounts.google.com", "client", "fixture-secret", "google-workspace"]) expect(body).not.toContain(value);
  });
  it.each([{}, { SHIBA_SSO_ENABLED: "1" }])("hides incomplete or disabled SSO without discovery or a database", async env => {
    const response = await handleBetterAuth(new Request(`${BASE}/api/auth/social-providers`), { ...env, BETTER_AUTH_SECRET: "s".repeat(32) });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ sso: { enabled: false, displayName: "Company SSO" } });
  });
});

describe("OIDC discovery and code exchange", () => {
  async function roundTrip(options: { preset?: boolean; allowed?: boolean; badSignature?: boolean; wrongNonce?: boolean; verified?: boolean; kind?: "bootstrap" | "invited"; owner?: boolean; linked?: boolean; newAccount?: boolean } = {}) {
    const remote = await issuer(options.preset ? GOOGLE_ISSUER : undefined);
    if (options.preset) routeIssuer(GOOGLE_ISSUER, remote.origin);
    const f = await fixture({ ...complete, ...(options.preset ? { SSO_OIDC_ISSUER: undefined, SSO_OIDC_PRESET: "google-workspace" } : { SSO_OIDC_ISSUER: remote.origin }),
      SSO_ALLOWED_DOMAINS: options.allowed === false ? "other.test" : "example.test",
      ...(options.owner ? { BETTER_AUTH_OWNER_EMAIL: "local@example.test" } : {}) });
    if (!options.newAccount) seed(f, options.verified ?? true, options.kind ?? (options.allowed === false ? "invited" : "bootstrap"));
    if (options.linked) f.sqlite.prepare(`INSERT INTO "account"(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('linked','subject','sso','local',?,?)`).run(Date.now(), Date.now());
    const start = await f.auth.handler(post("sign-in/social", { provider: "sso", callbackURL: `${BASE}/app/` }));
    expect(start.status).toBe(200);
    const target = new URL((await start.json() as { url: string }).url);
    expect(target.origin + target.pathname).toBe(`${remote.origin}/authorize`);
    expect(target.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", "profile"]);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/sso`);
    const nonce = target.searchParams.get("nonce"); expect(nonce).toBeTruthy();
    remote.setClaims({ nonce: options.wrongNonce ? "wrong" : (nonce ?? ""), badSignature: options.badSignature });
    const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await f.auth.handler(new Request(`${BASE}/api/auth/callback/sso?code=fixture&state=${encodeURIComponent(target.searchParams.get("state") ?? "")}`, { headers: { cookie } }));
    expect(remote.tokenBody()?.get("code")).toBe("fixture");
    const verifier = remote.tokenBody()?.get("code_verifier"); expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier ?? "").digest("base64url")).toBe(target.searchParams.get("code_challenge"));
    return { f, callback };
  }
  it.each(["bootstrap", "invited"] as const)("signs in an allowed verified %s with a signed ID token", async kind => {
    const { f, callback } = await roundTrip({ kind });
    expect(callback.headers.get("location")).toBe(`${BASE}/app/`);
    const cookie = callback.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(await resolveBetterAuthUserId(new Request(`${BASE}/api/whoami`, { headers: { cookie } }), f.env)).toBe("local@example.test");
    expect(f.sqlite.prepare('SELECT providerId FROM "account"').get()?.providerId).toBe("sso");
    f.sqlite.close();
  });
  it("signs in through the Google Workspace preset on the same callback", async () => {
    const { f, callback } = await roundTrip({ preset: true });
    expect(callback.headers.get("location")).toBe(`${BASE}/app/`);
    expect(f.sqlite.prepare('SELECT providerId FROM "account"').get()?.providerId).toBe("sso");
    f.sqlite.close();
  });
  it("refuses a disallowed domain through the Google Workspace preset", async () => {
    const { f, callback } = await roundTrip({ preset: true, allowed: false });
    expect(callback.headers.get("location")).toContain("sso_domain_not_allowed");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
    f.sqlite.close();
  });
  it("allows the configured owner email outside the domain list", async () => {
    const { f, callback } = await roundTrip({ allowed: false, owner: true });
    expect(callback.headers.get("location")).toBe(`${BASE}/app/`); f.sqlite.close();
  });
  it("allows the recorded bootstrap owner without an owner email setting", async () => {
    const { f, callback } = await roundTrip({ allowed: false, kind: "bootstrap" });
    expect(callback.headers.get("location")).toBe(`${BASE}/app/`); f.sqlite.close();
  });
  it("does not create an account without prior invitation enrollment", async () => {
    const { f, callback } = await roundTrip({ newAccount: true });
    expect(callback.headers.get("location")).toContain("error=signup_disabled");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "user"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
    f.sqlite.close();
  });
  it("rejects a returning linked account when its domain is no longer allowed", async () => {
    const { f, callback } = await roundTrip({ allowed: false, linked: true });
    expect(callback.headers.get("location")).toContain("sso_domain_not_allowed");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(1);
    f.sqlite.close();
  });
  it.each([{ allowed: false }, { badSignature: true }, { wrongNonce: true }, { verified: false }])("rejects invalid identity or domain %j before linking", async options => {
    const { f, callback } = await roundTrip(options);
    expect(callback.headers.get("location")).toContain("error=");
    if (options.allowed === false) expect(callback.headers.get("location")).toContain("sso_domain_not_allowed");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
    f.sqlite.close();
  });
});
