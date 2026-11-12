import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PinnedUpstreamModules, UpstreamSecretCodec, UpstreamReadContext } from "../src/upstream-adapter.js";
import { CoordinatedOwner, type CoordinatedD1 } from "../src/coordinated-owner.js";
import { operatorUpstreamCapture } from "../src/operator-upstream.js";
import { hash, digest } from "../src/json.js";
import { OPERATOR_INPUT_SCHEMA, type OperatorExecutionEnvelope } from "../src/operator-envelope.js";
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
  let code = fixture ? stripTypeScriptTypes(fixture.content, { mode: "transform" }) : (stub ?? "");
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
      async raw<T>() { return database.sqlite.prepare(sql).all(...values) as T[]; },
      async run() { database.queries.push(sql); const result = database.sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      allSync() { database.queries.push(sql); const result = database.sqlite.prepare(sql).all(...values); if (sql.includes("from connections where")) { database.connectionReads++; database.afterConnectionRead?.(); } return result; },
    });
    return statement();
  }
  async exec(sql: string) { this.sqlite.exec(sql); }
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
afterEach(() => { vi.restoreAllMocks(); });
const TOKEN = `oct_${"a".repeat(43)}`, KEY = "figd_fixture_operator_key_not_real_1234567";
async function fixture() {
  const db = new FixtureD1(), owner = new CoordinatedOwner(), facade = owner.database(db as CoordinatedD1);
  db.sqlite.exec("CREATE TABLE connections(id TEXT,revision TEXT,service TEXT,connection_name TEXT,source TEXT,value TEXT); CREATE TABLE runtime_tokens(id TEXT,name TEXT,token_hash TEXT,allowed_actions TEXT,blocked_actions TEXT,allowed_proxies TEXT,allowed_connections TEXT,allowed_triggers TEXT,created_at TEXT,last_used_at TEXT); CREATE TABLE runtime_policy(id INTEGER,value TEXT,updated_at TEXT)");
  const alias = `u_${(await digest("owner-1")).slice(0, 16)}`;
  const credential = { authType: "api_key", apiKey: KEY, values: { apiKey: KEY }, profile: { accountId: "fixture-account", displayName: "Fixture account", grantedScopes: [] }, metadata: {} };
  db.sqlite.prepare("INSERT INTO connections VALUES(?,?,?,?,?,?)").run("raw-1", "revision-1", "figma", alias, "local", await codec.encode(JSON.stringify(credential)));
  db.sqlite.prepare("INSERT INTO runtime_tokens VALUES(?,?,?,?,?,?,?,?,?,NULL)").run("token-1", "Fixture", createHash("sha256").update(TOKEN).digest("base64url"), '["figma.get_file_metadata"]', '[]', '[]', '["raw-1"]', '[]', new Date().toISOString());
  const input = { provider: "figma", actionId: "figma.get_file_metadata", rawConnectionId: "raw-1", upstreamRevision: "revision-1", ownerId: "owner-1", personalAlias: alias, arguments: { fileKey: "file123" }, maxBytes: 4096, inputSchemaHash: await hash(OPERATOR_INPUT_SCHEMA) } as OperatorExecutionEnvelope;
  const transport = vi.fn<typeof fetch>(async () => Response.json({ file: { name: "Fixture", last_touched_at: "2026-11-07T00:00:00Z" } }));
  const env = { DB: facade, OOMOL_CONNECT_ENCRYPTION_KEY: "fixture-encryption-passphrase-not-a-real-credential" };
  const capture = operatorUpstreamCapture(facade, env, modules as unknown as PinnedUpstreamModules<CoordinatedD1>, transport);
  const call = () => owner.run(async () => { const { request } = await capture(input, TOKEN); return request.project(await request.send(AbortSignal.timeout(1000)), AbortSignal.timeout(1000)); });
  return { db, owner, facade, input, credential, env, transport, call, capture };
}
describe("operator capture using pinned actual encrypted storage, token and policy APIs", () => {
  it("proves local provenance from raw SQL, captures native revision and dispatches only the fixed request", async () => {
    const f = await fixture(); expect(await f.call()).toEqual({ name: "Fixture", lastTouchedAt: "2026-11-07T00:00:00.000Z" }); expect(f.transport).toHaveBeenCalledOnce();
    expect(f.db.queries.some(sql => sql.includes("SELECT id,revision,service,connection_name,source,value"))).toBe(true);
    expect(f.db.sqlite.prepare("SELECT last_used_at FROM runtime_tokens").get()?.last_used_at).toBeTruthy();
  });
  it.each(["rotation", "delete", "saas", "plaintext", "oauth", "custom", "conflicting-key", "missing-key", "wrong-alias", "wrong-owner-scope"])("rejects %s without a provider request", async mode => {
    const f = await fixture();
    if (mode === "rotation") f.db.sqlite.exec("UPDATE connections SET revision='revision-2'");
    if (mode === "delete") f.db.sqlite.exec("DELETE FROM connections");
    if (mode === "saas") f.db.sqlite.exec("UPDATE connections SET source='saas'");
    if (mode === "plaintext") f.db.sqlite.prepare("UPDATE connections SET value=?").run(JSON.stringify(f.credential));
    if (["oauth", "custom", "conflicting-key", "missing-key"].includes(mode)) {
      const credential = { ...f.credential, authType: mode === "oauth" ? "oauth2" : mode === "custom" ? "custom_credential" : "api_key", values: mode === "missing-key" ? {} : { apiKey: mode === "conflicting-key" ? "another-key" : KEY } };
      f.db.sqlite.prepare("UPDATE connections SET value=?").run(await codec.encode(JSON.stringify(credential)));
    }
    if (mode === "wrong-alias") f.input.personalAlias = "default";
    if (mode === "wrong-owner-scope") f.input.personalAlias = `w_${"a".repeat(32)}`;
    await expect(f.call()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["revoked", "wildcard-action", "empty-action", "extra-action", "wrong-connection", "wildcard-connection", "empty-connection", "proxy", "trigger", "blocked"])("rejects runtime token %s", async mode => {
    const f = await fixture();
    if (mode === "revoked") f.db.sqlite.exec("DELETE FROM runtime_tokens");
    if (mode === "wildcard-action") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["*"]'`);
    if (mode === "empty-action") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='[]'`);
    if (mode === "extra-action") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["figma.get_file_metadata","figma.post_comment"]'`);
    if (mode === "wrong-connection") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_connections='["other"]'`);
    if (mode === "wildcard-connection") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_connections='["*"]'`);
    if (mode === "empty-connection") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_connections='[]'`);
    if (mode === "proxy") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_proxies='["*"]'`);
    if (mode === "trigger") f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_triggers='["*"]'`);
    if (mode === "blocked") f.db.sqlite.prepare("INSERT INTO runtime_policy VALUES(1,?,?)").run(JSON.stringify({ ...modules.emptyPolicyRules(), blockedActions: ["figma.get_file_metadata"] }), new Date().toISOString());
    await expect(f.call()).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("cannot capture outside owner scope or from an unencrypted codec", async () => {
    const f = await fixture(); await expect(f.capture(f.input, TOKEN)).rejects.toThrow("operator_scope_closed"); delete (f.env as Partial<typeof f.env>).OOMOL_CONNECT_ENCRYPTION_KEY;
    await expect(f.call()).rejects.toThrow("operator_encrypted_storage_required"); expect(f.transport).not.toHaveBeenCalled();
  });
});
