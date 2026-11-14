import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { betterAuthFor, ensureBetterAuthSchema, type BetterAuthEnrollmentAdapter } from "../src/better-auth.js";

const BASE = "https://auth.example.test";
const sendPasswordResetEmail = vi.fn(async () => {});
const adapter: BetterAuthEnrollmentAdapter = {
  enabled: true,
  validateInvitation: async () => null,
  isEnrollmentCurrent: async () => false,
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail,
};

describe("password reset", () => {
  it("wires sendResetPassword to the enrollment adapter", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const value = (v: unknown): never => (v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : v ?? null) as never;
    const prepared = (sql: string, params: unknown[] = []) => ({
      bind: (...args: unknown[]) => prepared(sql, args),
      async all() { return { results: sqlite.prepare(sql).all(...params.map(value)), meta: {} }; },
      async run() { return this.all(); },
      async first() { return sqlite.prepare(sql).get(...params.map(value)) ?? null; },
    });
    const db = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql),
      batch: async (statements: ReturnType<typeof prepared>[]) => Promise.all(statements.map((s) => s.all())) } as unknown as D1Database;
    const env = { AGENT_AUDIT: db, BETTER_AUTH_SECRET: "p".repeat(32), BETTER_AUTH_URL: BASE, BETTER_AUTH_BOOTSTRAP_TOKEN: "bootstrap" };
    await ensureBetterAuthSchema({ AGENT_AUDIT: db });
    const auth = await betterAuthFor(env, adapter);
    expect(typeof auth.options.emailAndPassword?.sendResetPassword).toBe("function");
    await auth.options.emailAndPassword?.sendResetPassword?.(
      { user: { id: "u1", email: "user@example.test", name: "User", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }, url: `${BASE}/auth/reset?token=abc`, token: "abc" },
      new Request(`${BASE}/api/auth/forget-password`, { method: "POST" }),
    );
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "user@example.test" }));
  });
});