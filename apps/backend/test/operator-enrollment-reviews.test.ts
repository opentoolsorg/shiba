import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { proposeOperatorEnrollment, decideOperatorEnrollment, listOperatorEnrollments } from "../src/operator-enrollment-store.js";
import { handleOperatorEnrollmentReviews } from "../src/operator-enrollment-routes.js";

const auth = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@shiba/auth/better-auth", () => ({ resolveBetterAuthSessionAccount: async () => auth.session }));
const OWNER = "owner@example.test", ACCOUNT = "native-owner", ORIGIN = "https://app.example.test";
const databases: DatabaseSync[] = [];
const owner = () => ({ ownerId: OWNER, accountId: ACCOUNT, sessionId: "owner-session", sessionExpiresAt: Date.now() + 3600_000 });
function fixture() {
  const sqlite = new DatabaseSync(":memory:"); databases.push(sqlite);
  sqlite.exec(readFileSync(new URL("../migrations/0037_operator_enrollment_review.sql", import.meta.url), "utf8"));
  sqlite.exec(`CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER);
    CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER);
    CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT);`);
  sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(ACCOUNT, OWNER);
  sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run("owner-session", ACCOUNT, Date.now() + 3600_000);
  sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,'bootstrap')").run(ACCOUNT, OWNER);
  const prepared = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...args: SQLInputValue[]) => prepared(sql, args),
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const env = { OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED: "true", AGENT_AUDIT: { prepare: (sql: string) => prepared(sql) } } as unknown as Env;
  return { env, sqlite };
}
function metadata() {
  return { provenance: "operator_api_key", provider: "fixture", accountLabel: "Fixture account", rawConnectionId: "fixture-row", upstreamRevision: "revision-1",
    deploymentEpoch: "fixture-epoch", versionId: "fixture-version", upstreamSourceRevision: "d89dc9f24f5a057bb500272d7dbf333837c77c68", manifestDigest: "a".repeat(64),
    operations: [{ actionId: "fixture/read", inputSchemaHash: "b".repeat(64), executorHash: "c".repeat(64) }], expiresAt: Date.now() + 3600_000 };
}
const proposal = (env: Env, input = metadata()) => proposeOperatorEnrollment(env, { ownerId: OWNER, accountId: ACCOUNT }, "fixture-operator", input);
function request(suffix = "", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/operator-enrollment-reviews${suffix}`, { method: body === undefined ? "GET" : "POST",
    headers: { cookie: "fixture-cookie", origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => { auth.session = { policy: { accountId: ACCOUNT, email: OWNER, kind: "bootstrap" }, emailVerified: true, sessionId: "owner-session", sessionExpiresAt: Date.now() + 3600_000 }; });
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("operator enrollment review metadata", () => {
  it("defaults off without storage access and never reports executable", async () => {
    const response = await handleOperatorEnrollmentReviews(request(), {} as Env);
    expect(await response?.json()).toEqual({ actorId: OWNER, ownerAccountId: ACCOUNT, enabled: false, executionAvailable: false, proposals: [] });
    await expect(proposal({} as Env)).rejects.toMatchObject({ code: "operator_review_disabled" });
  });
  it("creates a private immutable generation and accepts only review metadata", async () => {
    const { env, sqlite } = fixture(), row = await proposal(env);
    expect(row).toMatchObject({ provenance: "operator_api_key", state: "proposed", executionAvailable: false });
    expect(row.personalAlias).toMatch(/^u_[a-f0-9]{16}$/);
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
    await decideOperatorEnrollment(env, owner(), row.enrollmentId, { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true });
    expect(await listOperatorEnrollments(env, owner())).toMatchObject([{ state: "accepted", version: 2, executionAvailable: false }]);
    expect(sqlite.prepare("SELECT decision_account_id FROM operator_enrollment_reviews").get()?.decision_account_id).toBe(ACCOUNT);
  });
  it.each(["credential", "apiKey", "token", "oauthAuthorizationId", "ownerId", "personalAlias", "connectionId", "state"])("rejects browser/credential field %s", async (field) => {
    const { env } = fixture();
    await expect(proposal(env, { ...metadata(), [field]: "forbidden-fixture-value" })).rejects.toMatchObject({ code: "operator_proposal_invalid" });
    expect(await listOperatorEnrollments(env, owner())).toEqual([]);
  });
  it("rejects duplicate actions, wildcard actions and excessive expiry", async () => {
    const { env } = fixture(), data = metadata();
    await expect(proposal(env, { ...data, operations: [...data.operations, ...data.operations] })).rejects.toMatchObject({ code: "operator_proposal_actions_invalid" });
    await expect(proposal(env, { ...data, operations: [{ ...data.operations[0], actionId: "*", inputSchemaHash: "b".repeat(64), executorHash: "c".repeat(64) }] })).rejects.toMatchObject({ code: "operator_proposal_invalid" });
    await expect(proposal(env, { ...data, expiresAt: Date.now() + 31 * 86400_000 })).rejects.toMatchObject({ code: "operator_proposal_expiry_invalid" });
  });
  it("rejects wrong owners and ABA account replacement without leaking proposal metadata", async () => {
    const { env } = fixture(), row = await proposal(env);
    for (const wrong of [{ ...owner(), ownerId: "foreign@example.test" }, { ...owner(), accountId: "replacement-native-account" }]) {
      expect(await listOperatorEnrollments(env, wrong)).toEqual([]);
      await expect(decideOperatorEnrollment(env, wrong, row.enrollmentId, { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true })).rejects.toBeDefined();
    }
  });
  it.each(["session", "verification", "policy", "expiry"])("atomically fences current owner %s", async (change) => {
    const { env, sqlite } = fixture(), row = await proposal(env);
    if (change === "session") sqlite.exec('DELETE FROM "session"');
    if (change === "verification") sqlite.exec('UPDATE "user" SET emailVerified=0');
    if (change === "policy") sqlite.exec("UPDATE shiba_auth_account_policy SET kind='invited'");
    if (change === "expiry") sqlite.exec('UPDATE "session" SET expiresAt=1');
    await expect(decideOperatorEnrollment(env, owner(), row.enrollmentId, { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true })).rejects.toMatchObject({ status: 409 });
    expect(await listOperatorEnrollments(env, owner())).toEqual([]);
    expect(sqlite.prepare("SELECT state FROM operator_enrollment_reviews").get()?.state).toBe("proposed");
  });
  it("retains revocation tombstones, denies stale decisions, and requires a new generation", async () => {
    const { env, sqlite } = fixture(), row = await proposal(env);
    const input = { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept" as const, reviewOnly: true as const };
    await decideOperatorEnrollment(env, owner(), row.enrollmentId, input);
    await expect(decideOperatorEnrollment(env, owner(), row.enrollmentId, input)).rejects.toMatchObject({ status: 409 });
    env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED = "false";
    await decideOperatorEnrollment(env, owner(), row.enrollmentId, { ...input, expectedOwnerAccountId: ACCOUNT, expectedVersion: 2, decision: "revoke" });
    expect(await listOperatorEnrollments(env, owner())).toMatchObject([{ state: "revoked", version: 3, revokedAt: expect.any(Number) }]);
    expect(() => sqlite.exec("DELETE FROM operator_enrollment_reviews")).toThrow("retain_operator_enrollment_tombstone");
    expect(() => sqlite.exec("UPDATE operator_enrollment_reviews SET state='accepted',version=4")).toThrow();
    env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED = "true";
    const fresh = await proposal(env);
    expect(fresh.enrollmentGeneration).not.toBe(row.enrollmentGeneration);
    expect(fresh.proposalDigest).not.toBe(row.proposalDigest);
  });
  it.each(["owner_id", "owner_account_id", "generation", "operator_id", "proposal_json", "proposal_digest"])("prevents repointing %s", async (column) => {
    const { env, sqlite } = fixture(); await proposal(env);
    expect(() => sqlite.exec(`UPDATE operator_enrollment_reviews SET ${column}='changed',state='accepted',version=2,decision_account_id='native-owner',decided_at=1`)).toThrow("immutable_operator_enrollment");
  });
  it("rejects expired proposals at the SQL decision fence", async () => {
    const { env } = fixture();
    const row = await proposal(env, { ...metadata(), expiresAt: Date.now() + 1000 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(decideOperatorEnrollment(env, owner(), row.enrollmentId, { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true })).rejects.toMatchObject({ status: 409 });
  });
});

describe("operator review HTTP boundary", () => {
  it.each([{ Authorization: "Bearer fixture" }, { "X-Shiba-Workspace": "workspace" }, { cookie: "" }] as Record<string, string>[])("rejects non-native personal contexts %j", async (headers) => {
    const { env } = fixture();
    if (headers.cookie === "") auth.session = null;
    expect((await handleOperatorEnrollmentReviews(request("", undefined, headers), env))?.status).toBe(403);
  });
  it("rejects unverified, invited and absent native sessions", async () => {
    const { env } = fixture(), original = auth.session as Record<string, unknown>;
    for (const value of [null, { ...original, emailVerified: false }, { ...original, policy: { accountId: ACCOUNT, email: OWNER, kind: "invited" } }]) {
      auth.session = value;
      expect((await handleOperatorEnrollmentReviews(request(), env))?.status).toBe(403);
    }
  });
  it("requires same-origin, strict bounded decisions and frozen digest", async () => {
    const { env } = fixture(), row = await proposal(env), path = `/${row.enrollmentId}/decision`;
    const input = { expectedOwnerAccountId: ACCOUNT, expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true };
    expect((await handleOperatorEnrollmentReviews(request(path, input, { origin: "https://evil.example" }), env))?.status).toBe(403);
    expect((await handleOperatorEnrollmentReviews(request(path, { ...input, rawConnectionId: "changed" }), env))?.status).toBe(400);
    expect((await handleOperatorEnrollmentReviews(request(path, { ...input, reviewOnly: false }), env))?.status).toBe(400);
    expect((await handleOperatorEnrollmentReviews(request(path, { ...input, extra: "x".repeat(3000) }), env))?.status).toBe(400);
    expect((await handleOperatorEnrollmentReviews(request(path, { ...input, proposalDigest: "f".repeat(64) }), env))?.status).toBe(409);
    expect((await handleOperatorEnrollmentReviews(request(path, input), env))?.status).toBe(200);
  });
  it("cannot upload proposals or execute and does not invoke a provider", async () => {
    const { env } = fixture(), fetcher = vi.fn(() => { throw new Error("Unexpected network"); }); vi.stubGlobal("fetch", fetcher);
    expect((await handleOperatorEnrollmentReviews(request("", metadata()), env))?.status).toBe(404);
    expect((await handleOperatorEnrollmentReviews(request("/execute", {}), env))?.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a stale native-account pin even for an otherwise valid owner decision", async () => {
    const { env } = fixture(), row = await proposal(env);
    const response = await handleOperatorEnrollmentReviews(request(`/${row.enrollmentId}/decision`, {
      expectedOwnerAccountId: "previous-native-owner", expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true,
    }), env);
    expect(response?.status).toBe(403);
    expect(await listOperatorEnrollments(env, owner())).toMatchObject([{ state: "proposed", version: 1 }]);
  });
});
