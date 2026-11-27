import { describe, expect, it, vi } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { nativeSessionFence, resolveNativeSession, sessionExpiryMs } from "../src/founder/native-session.js";
vi.mock("@shiba/auth/better-auth", () => ({ resolveBetterAuthSessionAccount: vi.fn(async () => ({ policy: { accountId: "user-a", email: "owner@example.test" }, emailVerified: true, sessionId: "session-a", sessionExpiresAt: Date.now() + 60_000 })) }));

const now = Date.now();
const captured = { id: "session-a", userId: "user-a", expiresAt: now + 60_000 };
function matches(db: ReturnType<typeof customAgentD1>, session = captured) {
  const fence = nativeSessionFence(session);
  return Boolean(db.sqlite.prepare(`SELECT 1 AS ok WHERE ${fence.sql}`).get(...fence.values));
}
function dbWith(expiresAt: number | string, id = captured.id, userId = captured.userId) {
  const db = customAgentD1();
  for (const accountId of new Set([userId, captured.userId])) db.sqlite.prepare('INSERT INTO "user"(id,email,emailVerified,name,createdAt,updatedAt) VALUES(?,?,1,\'Fixture\',1,1)').run(accountId, `${accountId}@example.test`);
  db.sqlite.prepare('INSERT INTO "session"(id,userId,expiresAt,token,createdAt,updatedAt) VALUES(?,?,?,\'token\',1,1)').run(id,userId,expiresAt);
  return db;
}

describe("founder native session fence", () => {
  it("accepts integer-ms and ISO expiry at exact milliseconds", () => {
    expect(matches(dbWith(captured.expiresAt))).toBe(true);
    expect(matches(dbWith(new Date(captured.expiresAt).toISOString()))).toBe(true);
  });
  it("preserves fractional milliseconds and rejects database expiry before captured expiry", () => {
    const expiry = now + 60_000.75;
    expect(matches(dbWith(expiry), { ...captured, expiresAt: expiry })).toBe(true);
    expect(matches(dbWith(Math.floor(expiry)), { ...captured, expiresAt: expiry })).toBe(false);
  });
  it("rejects expired DB or captured sessions and mismatched identities", () => {
    expect(matches(dbWith(now - 1))).toBe(false);
    expect(matches(dbWith(captured.expiresAt), { ...captured, expiresAt: now - 1 })).toBe(false);
    expect(matches(dbWith(captured.expiresAt, "other", captured.userId))).toBe(false);
    expect(matches(dbWith(captured.expiresAt, captured.id, "other"))).toBe(false);
  });
  it("requires a cookie and rejects authorization headers", async () => {
    const member = { accountId: "user-a", userId: "owner@example.test" } as never;
    const env = {} as never;
    expect(await resolveNativeSession(new Request("https://shiba.test"), env, member)).toBeNull();
    expect(await resolveNativeSession(new Request("https://shiba.test", { headers: { cookie: "session=x", authorization: "Bearer x" } }), env, member)).toBeNull();
    expect(await resolveNativeSession(new Request("https://shiba.test", { headers: { cookie: "session=x" } }), env, member)).toEqual({ id: "session-a", userId: "user-a", expiresAt: expect.any(Number) });
  });
  it("parses numeric milliseconds and ISO strings", () => {
    expect(sessionExpiryMs(captured.expiresAt)).toBe(captured.expiresAt);
    expect(sessionExpiryMs(String(captured.expiresAt))).toBe(captured.expiresAt);
    expect(sessionExpiryMs(new Date(captured.expiresAt).toISOString())).toBe(captured.expiresAt);
    expect(sessionExpiryMs("not-an-expiry")).toBeNull();
  });
  it("keeps SQL text constant across calls", () => {
    expect(nativeSessionFence(captured).sql).toBe(nativeSessionFence({ ...captured, id: "other", expiresAt: now + 2 }).sql);
  });
});
