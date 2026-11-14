import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { betterAuthFor, ensureBetterAuthSchema, type BetterAuthEnrollmentAdapter } from "../src/better-auth.js";

const BASE = "http://localhost:8787";
const adapter: BetterAuthEnrollmentAdapter = {
  enabled: true,
  validateInvitation: async () => null,
  isEnrollmentCurrent: async () => false,
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};
async function fixture() {
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
  const env = { AGENT_AUDIT: db, BETTER_AUTH_SECRET: "v".repeat(32), BETTER_AUTH_URL: BASE };
  await ensureBetterAuthSchema({ AGENT_AUDIT: db });
  return { env };
}

describe("requireEmailVerification", () => {
  it("is enabled for invitation enrollment and disabled for bootstrap-only lanes", async () => {
    const f = await fixture();
    const enrolled = await betterAuthFor(f.env, adapter);
    const bootstrapOnly = await betterAuthFor(f.env);
    expect(enrolled.options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(bootstrapOnly.options.emailAndPassword?.requireEmailVerification).toBe(false);
    expect(enrolled.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });
});