import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleBetterAuth } from "../src/better-auth.js";
import { handleOperatorEnrollmentReviews } from "../src/operator-enrollment-routes.js";
import { proposeOperatorEnrollment } from "../src/operator-enrollment-store.js";

const BASE = "https://enrollment.example.test", EMAIL = "owner@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { origin: BASE, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fixture() {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL("../migrations/0037_operator_enrollment_review.sql", import.meta.url), "utf8"));
  const value = (input: unknown): SQLInputValue => input instanceof Date ? input.getTime() : typeof input === "boolean" ? Number(input) : input as SQLInputValue;
  const prepared = (sql: string, values: unknown[] = []) => ({
    bind: (...input: unknown[]) => prepared(sql, input),
    async all() { const results = sqlite.prepare(sql).all(...values.map(value)); return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() c").get()?.c) } }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...values.map(value)) ?? null; },
  });
  const database = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql), async batch(statements: ReturnType<typeof prepared>[]) {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = []; for (const statement of statements) result.push(await statement.all()); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } } as unknown as D1Database;
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "fixture-native-enrollment-secret-32-characters",
    BETTER_AUTH_URL: BASE, BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-bootstrap", OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED: "true" } as Env;
  return { env, sqlite };
}

describe("operator review with real local native-cookie auth", () => {
  it("requires verified owner, accepts exact metadata review, and denies a revoked native session", async () => {
    const { env, sqlite } = fixture();
    const registered = await handleBetterAuth(request("/api/auth/sign-up/email", { name: "Fixture owner", email: EMAIL, password: "fixture-owner-password" },
      { "x-shiba-bootstrap-token": "fixture-bootstrap" }), env, { teamMemberPolicyEnabled: true });
    expect(registered?.status).toBe(200);
    const cookie = registered?.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") ?? "";
    expect(cookie.length).toBeGreaterThan(0);
    const api = (path = "", body?: unknown) => handleOperatorEnrollmentReviews(request(`/api/operator-enrollment-reviews${path}`, body, { cookie }), env);
    expect((await api())?.status).toBe(403);
    sqlite.prepare('UPDATE "user" SET emailVerified=1 WHERE email=?').run(EMAIL);
    const owner = sqlite.prepare('SELECT id FROM "user" WHERE email=?').get(EMAIL);
    if (typeof owner?.id !== "string") throw new Error("Fixture native owner missing.");
    const row = await proposeOperatorEnrollment(env, { ownerId: EMAIL, accountId: owner.id }, "fixture-operator", {
      provenance: "operator_api_key", provider: "fixture", accountLabel: "Native cookie fixture", rawConnectionId: "fixture-account", upstreamRevision: "revision-1",
      deploymentEpoch: "fixture-epoch", versionId: "fixture-version", upstreamSourceRevision: "d89dc9f24f5a057bb500272d7dbf333837c77c68", manifestDigest: "a".repeat(64),
      operations: [{ actionId: "fixture/read", inputSchemaHash: "b".repeat(64), executorHash: "c".repeat(64) }], expiresAt: Date.now() + 3600_000,
    });
    const directory = await api();
    expect(directory?.status).toBe(200);
    expect(directory?.headers.get("cache-control")).toBe("no-store");
    expect(await directory?.json()).toMatchObject({ actorId: EMAIL, ownerAccountId: owner.id, executionAvailable: false, proposals: [{ enrollmentId: row.enrollmentId, state: "proposed" }] });
    const accepted = await api(`/${row.enrollmentId}/decision`, { expectedOwnerAccountId: owner.id, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true });
    expect(accepted?.status).toBe(200);
    expect(await accepted?.json()).toMatchObject({ executionAvailable: false, proposals: [{ state: "accepted", version: 2 }] });
    sqlite.exec('DELETE FROM "session"');
    expect((await api())?.status).toBe(403);
    expect((await api(`/${row.enrollmentId}/decision`, { expectedOwnerAccountId: owner.id, expectedVersion: 2, proposalDigest: row.proposalDigest, decision: "revoke", reviewOnly: true }))?.status).toBe(403);
    expect(sqlite.prepare("SELECT state FROM operator_enrollment_reviews").get()?.state).toBe("accepted");
  });
});
