import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBetterAuth, resolveBetterAuthUserId } from "../src/better-auth.js";
import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { isWorkspaceNativeAccountCurrent } from "../src/workspace-native-authority.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { isTeamModelFunder } from "../src/team-model-store.js";
import type { Env } from "../src/env.js";

const BASE = "https://bootstrap.example.test", EMAIL = "owner@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  const value = (item: unknown): never => (item instanceof Date ? item.getTime() : typeof item === "boolean" ? Number(item) : item ?? null) as never;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() { const results = sqlite.prepare(sql).all(...values.map(value)); return { results, meta: { changes: Number((sqlite.prepare("SELECT changes() AS c").get() as { c: number }).c) } }; },
    async run() { return this.all(); }, async first() { return sqlite.prepare(sql).get(...values.map(value)) ?? null; },
  });
  const database = { prepare: (sql: string) => statement(sql), exec: (sql: string) => sqlite.exec(sql),
    async batch(items: ReturnType<typeof statement>[]) { sqlite.exec("BEGIN IMMEDIATE"); try { const results = []; for (const item of items) results.push(await item.all()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } } as unknown as D1Database;
  const send = vi.fn(async (_input: { text: string; to: string }) => {});
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "v".repeat(32), BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-bootstrap", BETTER_AUTH_VERIFICATION_FROM: "auth@example.test", SEND_EMAIL: { send } } as unknown as Env;
  const request = (path: string, method = "GET", body?: unknown, cookie = "", origin = BASE) => new Request(`${BASE}${path}`, { method,
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = async (path: string, method = "GET", body?: unknown, cookie = "", origin = BASE) => (await handleBetterAuth(request(path, method, body, cookie, origin), env))!;
  const cookie = (response: Response) => response.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
  return { sqlite, env, send, request, call, cookie };
}
async function bootstrap(f: ReturnType<typeof fixture>) {
  const response = (await handleBetterAuth(new Request(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", "x-shiba-bootstrap-token": "fixture-bootstrap" },
    body: JSON.stringify({ name: "Owner", email: EMAIL, password: "password-123", emailVerified: true }) }), f.env))!;
  expect(response.status).toBe(200); expect(f.send).not.toHaveBeenCalled();
  return f.cookie(response);
}
async function issue(f: ReturnType<typeof fixture>, cookie: string) {
  const status = await (await f.call("/api/auth/bootstrap-verification", "GET", undefined, cookie)).json() as { statusSnapshot: string };
  const sent = await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: status.statusSnapshot }, cookie);
  expect(sent.status).toBe(200); expect(await sent.json()).toEqual({ sent: true });
  const mail = f.send.mock.calls.at(-1)![0], link = new URL(mail.text.match(/https:\/\/\S+/)![0]);
  const token = new URLSearchParams(link.hash.slice(1)).get("bootstrapVerification")!;
  return { token, link, status, mail };
}
describe("explicit bootstrap verification with real signed Better Auth proof", () => {
  it("keeps login compatible, sends only after explicit request, and atomically verifies the original native UUID", async () => {
    const f = fixture(), cookie = await bootstrap(f);
    expect(await resolveBetterAuthUserId(f.request("/api/whoami", "GET", undefined, cookie), f.env)).toBe(EMAIL);
    const status = await (await f.call("/api/auth/bootstrap-verification", "GET", undefined, cookie)).json();
    expect(status).toMatchObject({ kind: "bootstrap", email: EMAIL, emailVerified: false, available: true });
    const workspace = await createTeamWorkspace(f.env, EMAIL, { name: "Verified funding fixture" });
    const member = await getTeamWorkspaceMembership(f.env, workspace.workspaceId, EMAIL);
    const before = await resolveBetterAuthSessionAccount(f.request("/api/whoami", "GET", undefined, cookie), f.env);
    const nativeMember = { ...member!, accountId: before!.policy.accountId };
    expect(await isTeamModelFunder(f.env, nativeMember)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    const proof = await issue(f, cookie);
    expect(proof.link.pathname).toBe("/app/"); expect(proof.link.search).toBe("?verify=bootstrap"); expect(proof.link.searchParams.has("token")).toBe(false);
    expect(proof.mail.to).toBe(EMAIL); expect(proof.mail.text).not.toContain("workspace invitation");
    const confirmed = await f.call("/api/auth/bootstrap-verification/confirm", "POST", { token: proof.token });
    expect(confirmed.status).toBe(200); expect(await confirmed.json()).toEqual({ verified: true });
    expect(confirmed.headers.get("referrer-policy")).toBe("no-referrer"); expect(confirmed.headers.has("set-cookie")).toBe(false);
    const identity = await resolveBetterAuthSessionAccount(f.request("/api/whoami", "GET", undefined, cookie), f.env);
    expect(identity).toMatchObject({ policy: { kind: "bootstrap", email: EMAIL }, emailVerified: true });
    expect(await isWorkspaceNativeAccountCurrent(f.env, { accountId: identity!.policy.accountId, userId: EMAIL, workspaceId: `ws_${"a".repeat(24)}`, role: "owner", version: 1, joinedAt: 1 })).toBe(true);
    expect(await isTeamModelFunder(f.env, nativeMember)).toBe(true);
    const again = await f.call("/api/auth/bootstrap-verification/confirm", "POST", { token: proof.token }); expect(again.ok).toBe(false);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM shiba_auth_bootstrap_verifications WHERE consumed_at IS NOT NULL").get()?.c).toBe(1);
  });
  it("does not send on ordinary signup, sign-in or generic library resend", async () => {
    const f = fixture(), cookie = await bootstrap(f);
    expect((await f.call("/api/auth/sign-in/email", "POST", { email: EMAIL, password: "password-123" })).status).toBe(200);
    expect((await f.call("/api/auth/send-verification-email", "POST", { email: EMAIL }, cookie)).ok).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("requires current session, explicit status snapshot and same origin; never accepts an email assertion", async () => {
    const f = fixture(), cookie = await bootstrap(f);
    const status = await (await f.call("/api/auth/bootstrap-verification", "GET", undefined, cookie)).json() as { statusSnapshot: string };
    for (const body of [{ email: "victim@example.test" }, { expectedSnapshot: status.statusSnapshot, emailVerified: true }, { expectedSnapshot: "f".repeat(64) }]) expect((await f.call("/api/auth/bootstrap-verification", "POST", body, cookie)).ok).toBe(false);
    expect((await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: status.statusSnapshot }, cookie, "https://evil.example")).ok).toBe(false);
    expect((await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: status.statusSnapshot })).status).toBe(401);
    expect(f.send).not.toHaveBeenCalled();
    f.sqlite.prepare('DELETE FROM "session"').run();
    expect((await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: status.statusSnapshot }, cookie)).status).toBe(401);
  });
  it("binds resend to the exact current session and rate limits explicit requests", async () => {
    const f = fixture(), cookie = await bootstrap(f), proof = await issue(f, cookie);
    expect((await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: proof.status.statusSnapshot }, cookie)).status).toBe(429);
    const fresh = f.cookie(await f.call("/api/auth/sign-in/email", "POST", { email: EMAIL, password: "password-123" }));
    expect((await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: proof.status.statusSnapshot }, fresh)).status).toBe(409);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rejects tampered and expired proofs without consuming valid proof or changing verification", async () => {
    const f = fixture(), proof = await issue(f, await bootstrap(f));
    const parts = proof.token.split("."); parts[1] = `${parts[1]!.slice(0, -1)}${parts[1]!.endsWith("A") ? "B" : "A"}`;
    expect((await f.call("/api/auth/bootstrap-verification/confirm", "POST", { token: parts.join(".") })).ok).toBe(false);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3601_000);
    expect((await f.call("/api/auth/bootstrap-verification/confirm", "POST", { token: proof.token })).ok).toBe(false);
    vi.useRealTimers();
    expect(f.sqlite.prepare('SELECT emailVerified FROM "user"').get()?.emailVerified).toBe(0);
    expect(f.sqlite.prepare("SELECT consumed_at FROM shiba_auth_bootstrap_verifications").get()?.consumed_at).toBeNull();
  });
  it.each(["email", "replacement", "provenance"])("rejects original proof after %s changes, including generic callback downgrade", async change => {
    const f = fixture(), proof = await issue(f, await bootstrap(f));
    if (change === "email") f.sqlite.prepare('UPDATE "user" SET email=?').run("changed@example.test");
    if (change === "replacement") { f.sqlite.prepare('DELETE FROM "user"').run(); f.sqlite.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)').run("replacement", "New", EMAIL); }
    if (change === "provenance") f.sqlite.prepare("DELETE FROM shiba_auth_account_policy").run();
    expect((await f.call("/api/auth/bootstrap-verification/confirm", "POST", { token: proof.token })).ok).toBe(false);
    expect((await f.call(`/api/auth/verify-email?token=${encodeURIComponent(proof.token)}`)).ok).toBe(false);
    for (const path of [`/api/auth/verify-email/?token=${encodeURIComponent(proof.token)}`, `/api/auth/verify-email?token=other&token=${encodeURIComponent(proof.token)}`]) {
      const bypass = await f.call(path); expect(bypass.status).toBe(403); expect(await bypass.json()).toMatchObject({ error: expect.stringContaining("Bootstrap email verification") });
    }
    expect(f.sqlite.prepare('SELECT emailVerified FROM "user"').get()?.emailVerified).toBe(0);
  });
  it("reports unavailable delivery and configured-sender failure without exposing token or changing login", async () => {
    const f = fixture(), cookie = await bootstrap(f), noSender = { ...f.env, SEND_EMAIL: undefined } as Env;
    const response = (await handleBetterAuth(f.request("/api/auth/bootstrap-verification", "GET", undefined, cookie), noSender))!;
    expect(await response.json()).toMatchObject({ available: false, emailVerified: false, reason: expect.stringContaining("SEND_EMAIL") });
    const status = await (await f.call("/api/auth/bootstrap-verification", "GET", undefined, cookie)).json() as { statusSnapshot: string };
    f.send.mockRejectedValueOnce(new Error("Do not echo raw mail or proof"));
    const failed = await f.call("/api/auth/bootstrap-verification", "POST", { expectedSnapshot: status.statusSnapshot }, cookie);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("Do not echo");
    expect(await resolveBetterAuthUserId(f.request("/api/whoami", "GET", undefined, cookie), f.env)).toBe(EMAIL);
  });
});
