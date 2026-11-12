import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { betterAuthFor, ensureBetterAuthSchema, resolveBetterAuthUserId, type BetterAuthLaneEnv } from "../src/better-auth.js";

const BASE = "http://localhost:8787";
const credentials = {
  BETTER_AUTH_GOOGLE_CLIENT_ID: "google-client", BETTER_AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
  BETTER_AUTH_SLACK_CLIENT_ID: "slack-client", BETTER_AUTH_SLACK_CLIENT_SECRET: "slack-secret",
};
async function fixture(overrides: Partial<BetterAuthLaneEnv> = {}) {
  const sqlite = new DatabaseSync(":memory:");
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
  return { sqlite, env, auth };
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
async function oauth(f: Fixture, provider: "google" | "slack", email = "local@example.test", verified = true, requestSignUp = false) {
  const context = await f.auth.$context;
  const runtime = context.socialProviders.find(p => p.id === provider);
  if (!runtime) throw new Error(`Missing provider ${provider}`);
  // Stub only the remote exchange/profile: state, callback, linking, hooks,
  // database writes and session issuance all run through Better Auth 1.7.7.
  runtime.validateAuthorizationCode = vi.fn(async () => ({ accessToken: "fixture-token", scopes: ["openid", "email", "profile"] }));
  runtime.getUserInfo = vi.fn(async () => ({ user: { name: "Remote", email, emailVerified: verified },
    data: { sub: "remote-subject", "https://slack.com/user_id": "remote-subject" } }));
  const start = await f.auth.handler(post("sign-in/social", { provider, callbackURL: `${BASE}/app/`, requestSignUp }));
  expect(start.status).toBe(200);
  const { url } = await start.json() as { url: string };
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("Missing OAuth state");
  const cookie = start.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  return f.auth.handler(new Request(`${BASE}/api/auth/callback/${provider}?code=fixture&state=${encodeURIComponent(state)}`, { headers: { cookie } }));
}
function cookieHeader(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function linkOAuth(f: Fixture, provider: "google" | "slack", expectedEmail = "local@example.test") {
  const signup = await f.auth.handler(post("sign-up/email", {
    name: "Local", email: expectedEmail, password: "fixture-password-123",
  }));
  expect(signup.status).toBe(200);
  const cookies = cookieHeader(signup);
  f.sqlite.prepare('UPDATE "user" SET emailVerified=1 WHERE email=?').run(expectedEmail);
  const runtime = (await f.auth.$context).socialProviders.find(p => p.id === provider);
  if (!runtime) throw new Error(`Missing provider ${provider}`);
  runtime.validateAuthorizationCode = vi.fn(async () => ({ accessToken: "fixture-token", scopes: ["openid", "email", "profile"] }));
  runtime.getUserInfo = vi.fn(async () => ({ user: { name: "Remote", email: expectedEmail, emailVerified: true },
    data: { sub: "remote-subject", "https://slack.com/user_id": "remote-subject" } }));
  const start = await f.auth.handler(new Request(`${BASE}/api/auth/link-social`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: cookies },
    body: JSON.stringify({ provider, callbackURL: `${BASE}/app/` }),
  }));
  expect(start.status).toBe(200);
  const { url } = await start.json() as { url: string };
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("Missing OAuth state");
  const callbackCookies = cookieHeader(signup, start);
  return f.auth.handler(new Request(`${BASE}/api/auth/callback/${provider}?code=fixture&state=${encodeURIComponent(state)}`, {
    headers: { cookie: callbackCookies },
  }));
}

describe("built-in social provider configuration", () => {
  it.each([
    [{}, ["google", "slack"]],
    [{ BETTER_AUTH_GOOGLE_CLIENT_ID: undefined }, ["slack"]],
    [{ BETTER_AUTH_GOOGLE_CLIENT_SECRET: " " }, ["slack"]],
    [{ BETTER_AUTH_SLACK_CLIENT_ID: "" }, ["google"]],
    [{ BETTER_AUTH_SLACK_CLIENT_SECRET: undefined }, ["google"]],
    [{ BETTER_AUTH_GOOGLE_CLIENT_SECRET: "", BETTER_AUTH_SLACK_CLIENT_SECRET: "" }, []],
  ] satisfies [Partial<BetterAuthLaneEnv>, string[]][])("includes only complete credential pairs: %j", async (overrides, expected) => {
    const f = await fixture(overrides);
    expect(Object.keys(f.auth.options.socialProviders ?? {})).toEqual(expected);
    for (const provider of (await f.auth.$context).socialProviders) {
      expect(provider.options).toMatchObject({ disableSignUp: true, requireEmailVerification: true, overrideUserInfoOnSignIn: false });
    }
    expect(f.auth.options.account?.accountLinking).toEqual({ enabled: true, requireLocalEmailVerified: true,
      allowDifferentEmails: false, trustedProviders: [], updateUserInfoOnLink: false });
  });

  it("uses Slack OpenID sign-in scopes and endpoint without installation scopes", async () => {
    const f = await fixture();
    const response = await f.auth.handler(post("sign-in/social", { provider: "slack", callbackURL: `${BASE}/app/` }));
    const { url } = await response.json() as { url: string };
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(target.searchParams.get("scope")?.split(" ")).toEqual(["openid", "profile", "email"]);
    expect(target.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/slack`);
  });
});

describe.each(["google", "slack"] as const)("%s social account policy", provider => {
  it.each([false, true])("never provisions a new user, including explicit signup=%s", async requestSignUp => {
    const f = await fixture();
    const response = await oauth(f, provider, "stranger@example.test", true, requestSignUp);
    expect(response.headers.get("location")).toContain("error=signup_disabled");
    for (const table of ["user", "account", "session", "shiba_auth_account_policy"]) {
      expect(f.sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c).toBe(0);
    }
  });

  it.each(["bootstrap", "invited"] as const)("signs into a verified existing %s without changing provenance", async kind => {
    const f = await fixture(); seed(f, true, kind);
    const before = f.sqlite.prepare("SELECT * FROM shiba_auth_account_policy").all();
    const response = await oauth(f, provider);
    expect(response.headers.get("location")).toBe(`${BASE}/app/`);
    const cookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    expect(await resolveBetterAuthUserId(new Request(`${BASE}/api/whoami`, { headers: { cookie } }), f.env)).toBe("local@example.test");
    expect(f.sqlite.prepare("SELECT * FROM shiba_auth_account_policy").all()).toEqual(before);
    expect(f.sqlite.prepare('SELECT name,emailVerified FROM "user"').get()).toEqual({ name: "Local", emailVerified: 1 });
    expect(f.sqlite.prepare('SELECT providerId,userId FROM "account"').get()).toEqual({ providerId: provider, userId: "local" });
  });

  it("cannot enroll another account after bootstrap, even with explicit signup", async () => {
    const f = await fixture(); seed(f);
    const before = f.sqlite.prepare("SELECT * FROM shiba_auth_account_policy").all();
    const response = await oauth(f, provider, "uninvited@example.test", true, true);
    expect(response.headers.get("location")).toContain("error=signup_disabled");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "user"').get()?.c).toBe(1);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
    expect(f.sqlite.prepare("SELECT * FROM shiba_auth_account_policy").all()).toEqual(before);
  });

  it.each(["bootstrap", "invited"] as const)("cannot verify or link an unverified %s", async kind => {
    const f = await fixture(); seed(f, false, kind);
    const response = await oauth(f, provider);
    expect(response.headers.get("location")).toContain("error=");
    expect(f.sqlite.prepare('SELECT emailVerified FROM "user"').get()?.emailVerified).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
  });

  it("rejects a verified account without provenance", async () => {
    const f = await fixture(); seed(f, true, null);
    const response = await oauth(f, provider);
    expect(response.headers.get("location")).toContain("error=social_sign_in_not_allowed");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(0);
  });

  it("links an explicit account only when the local verified account has provenance", async () => {
    const allowed = await fixture();
    const linked = await linkOAuth(allowed, provider);
    expect(linked.headers.get("location")).toBe(`${BASE}/app/`);
    expect(allowed.sqlite.prepare('SELECT providerId,userId FROM "account" WHERE providerId=?').get(provider)).toEqual({ providerId: provider, userId: expect.any(String) });

    const denied = await fixture();
    const signup = await denied.auth.handler(post("sign-up/email", {
      name: "Local", email: "local@example.test", password: "fixture-password-123",
    }));
    expect(signup.status).toBe(200);
    denied.sqlite.prepare('UPDATE "user" SET emailVerified=1 WHERE email=?').run("local@example.test");
    denied.sqlite.prepare("DELETE FROM shiba_auth_account_policy").run();
    const accountCountBefore = denied.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c;
    const cookie = cookieHeader(signup);
    const context = await denied.auth.$context;
    const runtime = context.socialProviders.find(item => item.id === provider);
    if (!runtime) throw new Error(`Missing provider ${provider}`);
    runtime.validateAuthorizationCode = vi.fn(async () => ({ accessToken: "fixture-token", scopes: ["openid", "email", "profile"] }));
    runtime.getUserInfo = vi.fn(async () => ({ user: { name: "Remote", email: "local@example.test", emailVerified: true },
      data: { sub: "remote-subject", "https://slack.com/user_id": "remote-subject" } }));
    const start = await denied.auth.handler(new Request(`${BASE}/api/auth/link-social`, {
      method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie },
      body: JSON.stringify({ provider, callbackURL: `${BASE}/app/` }),
    }));
    expect(start.status).toBe(200);
    const { url } = await start.json() as { url: string };
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("Missing OAuth state");
    const callback = await denied.auth.handler(new Request(`${BASE}/api/auth/callback/${provider}?code=fixture&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookieHeader(signup, start) },
    }));
    expect(callback.headers.get("location")).toContain("error=social_sign_in_not_allowed");
    expect(denied.sqlite.prepare('SELECT COUNT(*) AS c FROM "account"').get()?.c).toBe(accountCountBefore);
    expect(denied.sqlite.prepare('SELECT COUNT(*) AS c FROM "account" WHERE providerId=?').get(provider)?.c).toBe(0);
  });

  it("rechecks linked accounts before provider claims can restore revoked verification", async () => {
    const f = await fixture(); seed(f);
    expect((await oauth(f, provider)).headers.get("location")).toBe(`${BASE}/app/`);
    f.sqlite.prepare('UPDATE "user" SET emailVerified=0').run();
    f.sqlite.prepare('DELETE FROM "session"').run();
    const response = await oauth(f, provider);
    expect(response.headers.get("location")).toContain("error=social_sign_in_not_allowed");
    expect(f.sqlite.prepare('SELECT emailVerified FROM "user"').get()?.emailVerified).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
  });

  it("requires provenance on returning sign-in, even for an already linked account", async () => {
    const f = await fixture(); seed(f);
    await oauth(f, provider);
    f.sqlite.prepare('DELETE FROM "session"').run();
    f.sqlite.prepare("DELETE FROM shiba_auth_account_policy").run();
    const response = await oauth(f, provider);
    expect(response.headers.get("location")).toContain("error=social_sign_in_not_allowed");
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM shiba_auth_account_policy").get()?.c).toBe(0);
  });

  it("rejects returning provider email changes and unverified provider emails", async () => {
    const f = await fixture(); seed(f);
    await oauth(f, provider);
    f.sqlite.prepare('DELETE FROM "session"').run();
    for (const [email, verified] of [["changed@example.test", true], ["local@example.test", false]] as const) {
      expect((await oauth(f, provider, email, verified)).headers.get("location")).toContain("error=social_sign_in_not_allowed");
    }
    expect(f.sqlite.prepare('SELECT email,emailVerified FROM "user"').get()).toEqual({ email: "local@example.test", emailVerified: 1 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM "session"').get()?.c).toBe(0);
  });
});
