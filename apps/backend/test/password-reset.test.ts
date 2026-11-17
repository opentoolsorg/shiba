import { DatabaseSync } from "node:sqlite";
import { applyAllMigrations } from "./fixtures/all-migrations.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBetterAuth, resolveBetterAuthUserId } from "../src/better-auth.js";
import type { Env } from "../src/env.js";
import { deliverEmailOutboxMessage } from "../src/email/delivery.js";
import { enqueueTransactionalEmail } from "../src/email/outbox.js";

const BASE = "https://team.example.test";
const owner = "owner@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  applyAllMigrations(sqlite);
  const bindValue = (value: unknown): never => (value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value ?? null) as never;
  const prepared = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepared(sql, args),
    async all() { const results = sqlite.prepare(sql).all(...params.map(bindValue)); return { results, meta: { changes: Number((sqlite.prepare("SELECT changes() AS c").get() as { c: number }).c) } }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...params.map(bindValue)) ?? null; },
  });
  const database = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql),
    async batch(statements: ReturnType<typeof prepared>[]) { sqlite.exec("BEGIN IMMEDIATE"); try { const result = []; for (const statement of statements) result.push(await statement.all()); sqlite.exec("COMMIT"); return result; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } } as unknown as D1Database;
  const send = vi.fn(async (_mail: unknown) => {});
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "e".repeat(32), BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "local-fixture-bootstrap", BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
    SEND_EMAIL: { send } } as unknown as Env;
  return { sqlite, env, send };
}
const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, {
  method, headers: { origin: BASE, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const auth = async (f: ReturnType<typeof fixture>, path: string, body: unknown) =>
  (await handleBetterAuth(request(path, "POST", body), f.env))!;
const cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
async function bootstrap(f: ReturnType<typeof fixture>) {
  const response = (await handleBetterAuth(request("/api/auth/sign-up/email", "POST",
    { name: "Owner", email: owner, password: "password-123" },
    { "x-shiba-bootstrap-token": "local-fixture-bootstrap" }), f.env))!;
  expect(response.status).toBe(200);
  return cookie(response);
}
const forgot = (f: ReturnType<typeof fixture>, email = owner) => auth(f, "/api/auth/request-password-reset", { email, redirectTo: `${BASE}/auth/reset` });
function deliveredLink(f: ReturnType<typeof fixture>) {
  const message = f.send.mock.calls[0]![0] as { text: string };
  return new URL(message.text.match(/https:\/\/\S+/)![0]);
}

describe("password reset", () => {
  it("delivers once, resets through the emailed link, consumes the token and revokes every session", async () => {
    const f = fixture(); const firstCookie = await bootstrap(f);
    const second = await auth(f, "/api/auth/sign-in/email", { email: owner, password: "password-123" });
    expect(second.status).toBe(200);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM session').get()?.c).toBe(2);
    const response = await forgot(f);
    expect(response.status).toBe(200);
    expect(f.send).toHaveBeenCalledTimes(1);
    const link = deliveredLink(f);
    expect(link.origin).toBe(BASE);
    expect(link.pathname).toBe("/auth/reset");
    const token = link.searchParams.get("token");
    expect(token).toBeTruthy();
    const reset = await auth(f, "/api/auth/reset-password", { token, newPassword: "new-password-456" });
    expect(reset.status).toBe(200);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS c FROM session').get()?.c).toBe(0);
    for (const value of [firstCookie, cookie(second)]) {
      expect(await resolveBetterAuthUserId(request("/api/whoami", "GET", undefined, { cookie: value }), f.env)).toBeNull();
    }
    expect((await auth(f, "/api/auth/sign-in/email", { email: owner, password: "password-123" })).status).toBe(401);
    expect((await auth(f, "/api/auth/sign-in/email", { email: owner, password: "new-password-456" })).status).toBe(200);
    expect((await auth(f, "/api/auth/reset-password", { token, newPassword: "another-password" })).status).toBe(400);
  }, 20_000);

  it("unknown email returns the same 200 response without sending anything", async () => {
    const f = fixture(); await bootstrap(f);
    const unknown = await forgot(f, "absent@example.test");
    expect(unknown.status).toBe(200);
    expect(f.send).not.toHaveBeenCalled();
    const known = await forgot(f);
    expect(known.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("expired and invalid tokens cannot change the password", async () => {
    const f = fixture(); await bootstrap(f); await forgot(f);
    const token = deliveredLink(f).searchParams.get("token");
    f.sqlite.prepare('UPDATE verification SET expiresAt=? WHERE identifier=?').run(Date.now() - 60_000, `reset-password:${token}`);
    for (const value of [token, "invalid-token"]) {
      expect((await auth(f, "/api/auth/reset-password", { token: value, newPassword: "new-password-456" })).status).toBe(400);
    }
    expect((await auth(f, "/api/auth/sign-in/email", { email: owner, password: "password-123" })).status).toBe(200);
  });

  it.each([false, true])("transport failure still returns the same response as an unknown account (missing sender: %s)", async (missingSender) => {
    const f = fixture(); await bootstrap(f);
    if (missingSender) delete f.env.SEND_EMAIL;
    else f.send.mockRejectedValueOnce(new Error("fixture delivery failure"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const known = await forgot(f), unknown = await forgot(f, "absent@example.test");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("limits public forgot and reset requests with AUTH_RATE_LIMIT before storage or sending", async () => {
    const f = fixture(); await bootstrap(f);
    const limit = vi.fn(async () => ({ success: false }));
    f.env.AUTH_RATE_LIMIT = { limit };
    for (const path of ["/api/auth/request-password-reset", "/api/auth/reset-password"]) {
      const response = await handleBetterAuth(request(path, "POST", { email: owner }, { "CF-Connecting-IP": "192.0.2.1" }), f.env);
      expect(response?.status).toBe(429);
      expect(response?.headers.get("Retry-After")).toBe("60");
    }
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenCalledWith({ key: "password-reset:192.0.2.1" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([false, true])("dry-run records redacted mail; full links require explicit logging (%s)", async (logLinks) => {
    const f = fixture(); await bootstrap(f);
    f.env.SHIBA_EMAIL_DRY_RUN = "1";
    f.env.SHIBA_EMAIL_DRY_RUN_LOG_LINKS = logLinks ? "1" : undefined;
    const queue = vi.fn(async () => {});
    f.env.EMAIL_QUEUE = { send: queue } as unknown as Queue;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await forgot(f)).status).toBe(200);
    expect(f.send).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    const row = f.sqlite.prepare("SELECT detail FROM audit_log WHERE tool='email.dry_run'").get()!;
    const detail = JSON.parse(String(row.detail));
    const token = String(f.sqlite.prepare("SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%'").get()!.identifier).slice("reset-password:".length);
    expect(detail).toEqual({ to: owner, subject: "Reset your Shiba password", link: `${BASE}/auth/reset?token=${token.slice(0, 6)}…` });
    expect(String(row.detail)).not.toContain(token);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM email_outbox").get()?.c).toBe(0);
    if (logLinks) expect(log).toHaveBeenCalledWith(`Email dry-run link: ${BASE}/auth/reset?token=${token}`);
    else expect(log).not.toHaveBeenCalled();
    expect((await auth(f, "/api/auth/reset-password", { token, newPassword: "new-password-456" })).status).toBe(200);
  });

  it("dry-run works without a real email binding", async () => {
    const f = fixture(); f.env.SHIBA_EMAIL_DRY_RUN = "1"; delete f.env.SEND_EMAIL;
    await bootstrap(f);
    expect((await forgot(f)).status).toBe(200);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE tool='email.dry_run'").get()?.c).toBe(1);
  });

  it("dry-run also prevents sending previously queued mail", async () => {
    const f = fixture();
    f.env.EMAIL_QUEUE = { send: vi.fn(async () => {}) } as unknown as Queue;
    const outboxId = await enqueueTransactionalEmail(f.env, { kind: "password_reset", to: owner, meta: { url: `${BASE}/auth/reset?token=fixture-token` } });
    f.env.SHIBA_EMAIL_DRY_RUN = "1";
    await deliverEmailOutboxMessage(f.env, { outboxId: outboxId! });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT status FROM email_outbox").get()?.status).toBe("sent");
    expect(f.sqlite.prepare("SELECT detail FROM audit_log").get()?.detail).not.toContain("fixture-token");
  });

  it("link logging alone does not enable dry-run", async () => {
    const f = fixture(); await bootstrap(f); f.env.SHIBA_EMAIL_DRY_RUN_LOG_LINKS = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await forgot(f)).status).toBe(200);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});
