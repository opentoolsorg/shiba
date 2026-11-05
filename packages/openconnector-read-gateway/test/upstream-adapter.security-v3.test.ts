// Upstream fixture loader reused from adapter tests; assertions independently exercise real pinned codec/token/storage APIs.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
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


async function comments(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.sqlite.exec("UPDATE connections SET service='figma' WHERE id='raw-one'");
  f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["figma.list_comments"]'`);
  return { ...f.input, operationId: "figma.list_comments", arguments: { fileKey: "fixedfile" }, providerConnectionId: `ocg_${await digest(JSON.stringify([ALIAS, "figma", "raw-one", "consent-one"]))}`, authorizationFingerprint: await digest(JSON.stringify([ALIAS, "figma", "consent-one"])) };
}
describe("independent read gateway security v3", () => {
  it("new comments cannot reinterpret an API key carrying copied OAuth metadata", async () => {
    const f = await fixture(), input = await comments(f);
    await f.save({ ...f.credential, authType: "api_key", apiKey: "fixture-key", metadata: { oauthAuthorizationId: "consent-one" } });
    expect((await f.call(input)).status).toBe(403); expect(f.provider).not.toHaveBeenCalled(); expect(f.manual).not.toHaveBeenCalled();
  });
  it("ignores connection additionalConfig endpoint and authentication overrides", async () => {
    const f = await fixture(), input = await comments(f);
    await f.save({ ...f.credential, additionalConfig: { baseUrl: "https://unselected.test", accessToken: "unselected-token", headers: { Authorization: "Bearer unselected-token" }, adAccountId: "unselected-account" } });
    const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ comments: [] })); vi.stubGlobal("fetch", network);
    expect((await f.call(input)).status).toBe(200); expect(network).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0]!;
    expect(String(url)).toBe("https://api.figma.com/v1/files/fixedfile/comments");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(JSON.stringify([url, init])).not.toContain("unselected");
  });
  it("metadata token cannot dispatch comments by substituting operation after pinning", async () => {
    const f = await fixture(), input = await comments(f);
    f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["figma.get_file_metadata"]'`);
    expect((await f.call(input)).status).toBe(403); expect(f.stages).not.toContain("dispatch"); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each(["stripe.list_subscriptions", "meta.list_ads"])("unsupported operation %s cannot borrow an existing OAuth grant", async (operationId) => {
    const f = await fixture();
    expect((await f.call({ ...f.input, operationId })).status).not.toBe(200); expect(f.provider).not.toHaveBeenCalled(); expect(f.manual).not.toHaveBeenCalled();
  });
});

const DEV = "fixture_googleads_developer_123456", FINGERPRINT_SECRET = "independent_fixture_hmac_secret_1234567890_abcdXYZ";
async function ads(f: Awaited<ReturnType<typeof fixture>>) {
  Object.assign(f.env, { SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY: FINGERPRINT_SECRET });
  Object.assign(f.credential.profile, { grantedScopes: ["https://www.googleapis.com/auth/adwords"] });
  f.db.sqlite.exec("UPDATE connections SET service='googleads' WHERE id='raw-one'");
  f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["googleads.campaign_daily_metrics"]'`);
  await f.save({ ...f.credential, metadata: { ...f.credential.metadata, oauthClientSecretExtra: { developerToken: DEV, baseUrl: "https://unselected.test", headers: { "developer-token": "unselected" } } } });
  return { ...f.input, operationId: "googleads.campaign_daily_metrics", arguments: { customerId: "1234567890", loginCustomerId: "0987654321", startDate: "2026-10-01", endDate: "2026-10-03" },
    providerConnectionId: `ocg_${await digest(JSON.stringify([ALIAS, "googleads", "raw-one", "consent-one"]))}`,
    authorizationFingerprint: await digest(JSON.stringify([ALIAS, "googleads", "consent-one"])),
    sourceFingerprint: createHmac("sha256", FINGERPRINT_SECRET).update(JSON.stringify(["shiba.googleads.source.v1", ALIAS, "raw-one", "consent-one", "revision-one", DEV])).digest("hex") };
}
describe("independent Google Ads source security v3", () => {
  it.each(["developer-token", "revision", "missing-fingerprint", "missing-signing-key"])("rejects old approval after %s changes before any provider fetch", async mode => {
    const f = await fixture(), input = await ads(f);
    if (mode === "missing-signing-key") Reflect.deleteProperty(f.env, "SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY");
    if (mode === "developer-token") await f.save({ ...f.credential, metadata: { ...f.credential.metadata, oauthClientSecretExtra: { developerToken: "fixture_different_developer_123456" } } });
    if (mode === "revision") f.db.sqlite.exec("UPDATE connections SET revision='revision-two' WHERE id='raw-one'");
    const body = mode === "missing-fingerprint" ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "sourceFingerprint")) : input;
    expect((await f.call(body)).status).not.toBe(200); expect(f.provider).not.toHaveBeenCalled(); expect(f.stages).not.toContain("dispatch");
  });
  it("uses only reviewed customer IDs and a fixed query with Worker-only developer credentials", async () => {
    const f = await fixture(), input = await ads(f);
    const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ results: [], echoedSecret: DEV })); vi.stubGlobal("fetch", network);
    const response = await f.call(input); expect(response.status).toBe(200); expect(network).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0]!; expect(url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search");
    expect(init?.method).toBe("POST"); const headers = new Headers(init?.headers); expect(headers.get("developer-token")).toBe(DEV); expect(headers.get("login-customer-id")).toBe("0987654321");
    expect(String(init?.body)).toContain("LIMIT 25"); expect(JSON.stringify([url, init])).not.toContain("unselected.test"); expect(await response.text()).not.toContain(DEV);
  });
  it("a scoped metadata-only runtime token cannot obtain Google Ads developer-source attestation", async () => {
    const f = await fixture(), input = await ads(f);
    f.db.sqlite.exec(`UPDATE runtime_tokens SET allowed_actions='["figma.get_file_metadata"]'`);
    const body = { alias: input.alias, providerConnectionId: input.providerConnectionId, authorizationFingerprint: input.authorizationFingerprint, versionId: input.versionId, manifestDigest: input.manifestDigest, capabilities: { claim: "fixture", complete: "fixture" } };
    expect((await f.call(body, `Bearer ${TOKEN}`, "/v1/shiba/read-gate/attest-googleads")).status).toBe(403);
    expect(f.db.connectionReads).toBe(0); expect(f.provider).not.toHaveBeenCalled();
  });
});
