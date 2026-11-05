import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { handlePinnedUpstreamReadGateway, type PinnedUpstreamModules, type UpstreamSecretCodec, type UpstreamReadContext } from "../src/upstream-adapter.js";
import { readGatewayManifest } from "../src/manifest.js";
import { digest, hash } from "../src/json.js";
import type { GatewayReadReceipt, ReadRequest } from "../src/types.js";

type SourceFixture = { revision: string; license: { content: string; sha: string }; files: Record<string, { content: string; sha: string }> };
const sources = JSON.parse(readFileSync(new URL("./fixtures/upstream-d89dc9.json", import.meta.url), "utf8")) as SourceFixture;
const blob = (value: string) => { const bytes = Buffer.from(value); return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); };
// Only constructors and functions unrelated to this read lane are stand-ins.
// Any attempted use of an unrelated storage/API function fails the fixture.
const stubs: Record<string, string> = {
  "src/server/api/http-utils.ts": "export class HttpRequestError extends Error {}",
  "src/server/api/runtime-api.ts": "export function parseRuntimeActionHttpResult(){throw Error('Non-read API invoked')}",
  "src/server/storage/connection-retirement.ts": "export function initializeRetirement(){throw Error('Non-read write invoked')} export const lockRetirement=initializeRetirement, retirementMatches=initializeRetirement;",
  "src/server/storage/connection-request-store.ts": "export class ConnectionRequestStore {}",
  "src/server/storage/oauth-state-store.ts": "export class SqlOAuthStateStore {}",
  "src/server/storage/trigger-store.ts": "export class SqlTriggerStore {}",
  "src/server/storage/saas-project-store.ts": "export class SaasProjectStore {} export function queueSaasConnections(){throw Error('SaaS forbidden')} export const readSaasConnection=queueSaasConnections;",
};
const urls = new Map<string, string>();
function sourceUrl(path: string): string {
  const cached = urls.get(path); if (cached) return cached;
  const fixture = sources.files[path], stub = stubs[path];
  if (!fixture && !stub) throw new Error(`Unreviewed upstream dependency: ${path}`);
  if (fixture && blob(fixture.content) !== fixture.sha) throw new Error(`Pinned source changed: ${path}`);
  let code = fixture ? stripTypeScriptTypes(fixture.content, { mode: "transform" }) : stub!;
  code = code.replace(/from\s+"([^"]+)"/g, (original, dependency: string) => dependency.startsWith("node:") ? original : `from ${JSON.stringify(sourceUrl(posix.normalize(posix.join(posix.dirname(path), dependency))))}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`; urls.set(path, url); return url;
}
async function actualModule<T>(path: string): Promise<T> { return await import(/* @vite-ignore */ sourceUrl(path)) as T; }

class FixtureD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly queries: string[] = [];
  afterConnectionRead: (() => void) | undefined;
  connectionReads = 0;
  prepare(sql: string) {
    const database = this;
    const statement = (values: SQLInputValue[] = []) => ({
      bind: (...input: unknown[]) => statement(input.map((value) => {
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
        throw new Error("Unsupported fixture SQL value");
      })),
      async first<T>() { database.queries.push(sql); return (database.sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
      async all<T>() { database.queries.push(sql); return { results: database.sqlite.prepare(sql).all(...values) as T[] }; },
      async run() { database.queries.push(sql); const result = database.sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      allSync() { database.queries.push(sql); const result = database.sqlite.prepare(sql).all(...values); if (sql.includes("from connections where")) { database.connectionReads++; database.afterConnectionRead?.(); } return result; },
    });
    return statement();
  }
  async batch(statements: ReturnType<FixtureD1["prepare"]>[]) { this.sqlite.exec("BEGIN"); try { const result = statements.map((statement) => ({ results: statement.allSync() })); this.sqlite.exec("COMMIT"); return result; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
}
let modules: PinnedUpstreamModules<FixtureD1>, codec: UpstreamSecretCodec;
beforeAll(async () => {
  const secret = await actualModule<{ createWorkerSecretCodec: PinnedUpstreamModules<FixtureD1>["createWorkerSecretCodec"] }>("src/server/secrets/worker-secret-codec.ts");
  const policy = await actualModule<{ emptyPolicyRules: PinnedUpstreamModules<FixtureD1>["emptyPolicyRules"]; parseActionPolicyList: PinnedUpstreamModules<FixtureD1>["parseActionPolicyList"]; ActionPolicySnapshot: new (...args: Parameters<PinnedUpstreamModules<FixtureD1>["createPolicy"]>) => ReturnType<PinnedUpstreamModules<FixtureD1>["createPolicy"]> }>("src/core/action-policy.ts");
  type Database = { connectionStore: { get: UpstreamReadContext["getConnection"] }; runtimeTokenStore: unknown; runtimePolicyStore: { get: UpstreamReadContext["getRuntimePolicy"] } };
  const database = await actualModule<{ D1RuntimeDatabase: new (binding: FixtureD1, options: { secretCodec: UpstreamSecretCodec }) => Database }>("src/server/storage/d1/runtime-store.ts");
  const runtime = await actualModule<{ RuntimeTokenService: new (store: unknown) => { resolveToken: UpstreamReadContext["resolveRuntimeToken"] } }>("src/server/storage/runtime-token-service.ts");
  modules = { ...secret, ...policy, createPolicy: (...args) => new policy.ActionPolicySnapshot(...args), createReadContext(binding, secretCodec) {
    const db = new database.D1RuntimeDatabase(binding, { secretCodec }), tokens = new runtime.RuntimeTokenService(db.runtimeTokenStore);
    return { getConnection: (service, alias) => db.connectionStore.get(service, alias), resolveRuntimeToken: (token) => tokens.resolveToken(token), getRuntimePolicy: () => db.runtimePolicyStore.get() };
  } };
  codec = await secret.createWorkerSecretCodec("fixture-encryption-passphrase-not-a-real-credential");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const TOKEN = `oct_${"a".repeat(43)}`, ALIAS = `w_${"b".repeat(32)}`, ACCESS = "fixture-access-token-never-real", REFRESH = "fixture-refresh-token-never-real", VERSION = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const db = new FixtureD1(); db.sqlite.exec("CREATE TABLE connections(id TEXT,revision TEXT,service TEXT,connection_name TEXT,source TEXT,value TEXT); CREATE TABLE runtime_tokens(id TEXT,name TEXT,token_hash TEXT,allowed_actions TEXT,blocked_actions TEXT,allowed_proxies TEXT,allowed_connections TEXT,allowed_triggers TEXT,created_at TEXT,last_used_at TEXT); CREATE TABLE runtime_policy(id INTEGER,value TEXT,updated_at TEXT)");
  const credential = { authType: "oauth2", accessToken: ACCESS, refreshToken: REFRESH, tokenType: "Bearer", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), profile: { accountId: "fixture", displayName: "Fixture", grantedScopes: [] }, metadata: { oauthAuthorizationId: "consent-one" } };
  const save = async (value: unknown, plaintext = false) => db.sqlite.prepare("UPDATE connections SET value=? WHERE id='raw-one'").run(plaintext ? JSON.stringify(value) : await codec.encode(JSON.stringify(value)));
  db.sqlite.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?)").run("raw-one", "revision-one", "github", ALIAS, "local", await codec.encode(JSON.stringify(credential)));
  db.sqlite.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?)").run("unselected", "other", "github", "default", "local", "plaintext-irrelevant-private-connection");
  db.sqlite.prepare("INSERT INTO runtime_tokens VALUES(?,?,?,?,?,?,?,?,?,NULL)").run("runtime-one", "Scoped fixture", createHash("sha256").update(TOKEN).digest("base64url"), '["github.list_pull_requests"]', "[]", "[]", '["raw-one"]', "[]", new Date().toISOString());
  db.sqlite.prepare("INSERT INTO runtime_policy VALUES(1,?,?)").run(JSON.stringify(modules.emptyPolicyRules()), new Date().toISOString());
  const manifest = await readGatewayManifest(), manifestDigest = await hash(manifest);
  const input: ReadRequest = { format: "shiba.scheduled-read.v1", versionId: VERSION, manifestDigest, grantId: "far_fixture", grantVersion: 1, occurrenceId: "occ_fixture", stepId: "step_fixture", stepDigest: "c".repeat(64), principal: { kind: "schedule", id: "schedule:far_fixture" }, workspaceId: `ws_${"a".repeat(24)}`, alias: ALIAS, connectionId: "workspace-one", providerConnectionId: `ocg_${await digest(JSON.stringify([ALIAS, "github", "raw-one", "consent-one"]))}`, authorizationFingerprint: await digest(JSON.stringify([ALIAS, "github", "consent-one"])), operationId: "github.list_pull_requests", arguments: { owner: "fixture", repo: "fixture", perPage: 5, state: "open" }, expiresAt: Date.now() + 15_000, maxBytes: 32768, maxDurationMs: 1000, capabilities: { claim: "claim-fixture", dispatch: "dispatch-fixture", complete: "complete-fixture" } };
  const stages: string[] = []; let prior: GatewayReadReceipt | undefined;
  const authority = { fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); stages.push(body.stage); if (body.stage === "complete") prior = body.receipt; return Response.json({ ok: true, ...(body.stage === "claim" && prior ? { receipt: prior } : {}) }); }) };
  const env = { DB: db, OOMOL_CONNECT_ENCRYPTION_KEY: "fixture-encryption-passphrase-not-a-real-credential", SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED: "true", SHIBA_AUTOMATIC_AUTHORITY: authority, CF_VERSION_METADATA: { id: VERSION, tag: "d".repeat(40) } };
  const provider = vi.fn(async () => Response.json({ data: [], access_token: ACCESS, nested: [REFRESH, TOKEN] })); vi.stubGlobal("fetch", provider);
  const manual = vi.fn(async () => new Response("Manual fixture only"));
  const call = (body: unknown = input, authorization = `Bearer ${TOKEN}`, path = "/v1/shiba/read-gate/execute") => handlePinnedUpstreamReadGateway(new Request(`https://sibling.test${path}`, { method: path.endsWith("/manifest") ? "GET" : "POST", headers: { authorization, "content-type": "application/json" }, ...(path.endsWith("/manifest") ? {} : { body: JSON.stringify(body) }) }), env, modules, manual);
  return { db, env, input, credential, save, provider, manual, stages, authority, call };
}

describe("pinned upstream adapter with actual Apache API sources and SQLite fixture", () => {
  it("verifies the exact revision, every source blob and the distributed license", () => { expect(sources.revision).toBe("d89dc9f24f5a057bb500272d7dbf333837c77c68"); for (const source of Object.values(sources.files)) expect(blob(source.content)).toBe(source.sha); expect(blob(sources.license.content)).toBe(sources.license.sha); expect(sources.license.content).toContain("Apache License"); });
  it("uses real encrypted SQL connection, stored runtime token and policy APIs for exactly the selected alias", async () => {
    const f = await fixture(), response = await f.call(); expect(response.status).toBe(200); const body = await response.text(); expect(body).not.toContain(ACCESS); expect(body).not.toContain(REFRESH); expect(body).not.toContain(TOKEN);
    expect(f.provider).toHaveBeenCalledOnce(); expect(f.db.connectionReads).toBe(2); expect(f.db.queries.filter((sql) => sql.includes("from connections"))).toEqual(["select * from connections where service = ? and connection_name = ?", "select * from connections where service = ? and connection_name = ?"]); expect(f.stages).toEqual(["claim", "dispatch", "complete"]);
  });
  it.each(["off", "missing-version", "missing-reverse"])("denies %s before provider or credential use", async (mode) => { const f = await fixture(); if (mode === "off") f.env.SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED = "false"; else if (mode === "missing-version") delete (f.env as Partial<typeof f.env>).CF_VERSION_METADATA; else delete (f.env as Partial<typeof f.env>).SHIBA_AUTOMATIC_AUTHORITY; expect((await f.call()).status).toBe(503); expect(f.provider).not.toHaveBeenCalled(); expect(f.db.connectionReads).toBe(0); });
  it.each(["empty-actions", "wildcard-actions", "empty-connections", "wrong-connection", "revoked-token", "admin-token"])("denies unscoped or changed runtime authority: %s", async (mode) => { const f = await fixture(); if (mode === "empty-actions") f.db.sqlite.exec("UPDATE runtime_tokens SET allowed_actions='[]'"); if (mode === "wildcard-actions") f.db.sqlite.exec("UPDATE runtime_tokens SET allowed_actions='[\"*\"]'"); if (mode === "empty-connections") f.db.sqlite.exec("UPDATE runtime_tokens SET allowed_connections='[]'"); if (mode === "wrong-connection") f.db.sqlite.exec("UPDATE runtime_tokens SET allowed_connections='[\"other\"]'"); if (mode === "revoked-token") f.db.sqlite.exec("DELETE FROM runtime_tokens"); expect((await f.call(undefined, mode === "admin-token" ? "Bearer fixture-admin-not-valid" : `Bearer ${TOKEN}`)).status).toBe(403); expect(f.provider).not.toHaveBeenCalled(); });
  it.each(["plaintext", "api-key", "expired", "invalid-expiry", "reauth", "missing-consent", "short-refresh", "saas"])("denies %s without refresh, API-key or default-connection fallback", async (mode) => {
    const f = await fixture(), value = { ...f.credential, metadata: { ...f.credential.metadata } } as Record<string, unknown>;
    if (mode === "api-key") value.authType = "api_key"; if (mode === "expired") value.expiresAt = new Date(Date.now() - 1).toISOString(); if (mode === "invalid-expiry") value.expiresAt = "not-time"; if (mode === "reauth") value.metadata = { oauthReauthRequired: true, oauthAuthorizationId: "consent-one" }; if (mode === "missing-consent") value.metadata = {}; if (mode === "short-refresh") value.refreshToken = "x";
    await f.save(value, mode === "plaintext"); if (mode === "saas") f.db.sqlite.exec("UPDATE connections SET source='saas' WHERE id='raw-one'"); expect((await f.call()).status).not.toBe(200); expect(f.provider).not.toHaveBeenCalled(); expect(f.manual).not.toHaveBeenCalled();
  });
  it.each(["token", "policy", "credential"])("rechecks %s after OAuth awaits before dispatch", async (mode) => { const f = await fixture(); f.db.afterConnectionRead = () => { if (f.db.connectionReads !== 1) return; if (mode === "token") f.db.sqlite.exec("DELETE FROM runtime_tokens"); else if (mode === "policy") f.db.sqlite.prepare("UPDATE runtime_policy SET value=?").run(JSON.stringify({ ...modules.emptyPolicyRules(), blockedActions: ["github.list_pull_requests"] })); else f.db.sqlite.exec("UPDATE connections SET revision='replaced' WHERE id='raw-one'"); }; expect((await f.call()).status).not.toBe(200); expect(f.provider).not.toHaveBeenCalled(); expect(f.stages).not.toContain("dispatch"); });
  it("never adopts another request's private database context even with the same encryption key", async () => { const first = await fixture(); expect((await first.call()).status).toBe(200); const second = await fixture(); second.db.sqlite.exec("DELETE FROM runtime_tokens"); expect((await second.call()).status).toBe(403); expect(first.provider).toHaveBeenCalledOnce(); expect(second.provider).not.toHaveBeenCalled(); expect(second.db.connectionReads).toBe(0); });
  it("requires the existing encryption key without constructing an unencrypted store", async () => { const f = await fixture(); delete (f.env as Partial<typeof f.env>).OOMOL_CONNECT_ENCRYPTION_KEY; expect((await f.call()).status).toBe(403); expect(f.provider).not.toHaveBeenCalled(); expect(f.db.connectionReads).toBe(0); });
  it.each(['["*"]', '["github.list_pull_requests","github.create_issue"]'])("refuses an unrestricted connection or write-capable runtime grant: %s", async (policy) => { const f = await fixture(); f.db.sqlite.prepare(policy.includes("create_issue") ? "UPDATE runtime_tokens SET allowed_actions=?" : "UPDATE runtime_tokens SET allowed_connections=?").run(policy); expect((await f.call()).status).toBe(403); expect(f.provider).not.toHaveBeenCalled(); expect(f.db.connectionReads).toBe(0); });
  it("keeps ordinary manual routing separate and never falls back for encoded reserved routes", async () => { const f = await fixture(); const request = new Request("https://sibling.test/api/providers"); expect((await handlePinnedUpstreamReadGateway(request, f.env, modules, f.manual)).status).toBe(200); expect(f.manual).toHaveBeenCalledOnce(); const response = await f.call(undefined, `Bearer ${TOKEN}`, "/v1/shiba/%72ead-gate/execute"); expect(response.status).toBe(404); expect(f.manual).toHaveBeenCalledOnce(); expect(f.provider).not.toHaveBeenCalled(); });
  it("returns a durable prior receipt without issuing another provider read", async () => { const f = await fixture(); expect((await f.call()).status).toBe(200); expect((await f.call()).status).toBe(200); expect(f.provider).toHaveBeenCalledOnce(); expect(f.stages).toEqual(["claim", "dispatch", "complete", "claim"]); });
});
