import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planReadGateway, parseReadGatewayConfig, readGatewayEntry, verifyReadGatewayApi } from "./openconnector-read-gateway.mjs";

const manual = () => ({ name: "shiba-openconnector", main: "src/server/cloudflare.ts", compatibility_date: "2026-07-02", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  assets: { binding: "ASSETS", directory: "dist/web" }, d1_databases: [{ binding: "DB", database_name: "shiba-openconnector", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "TRANSIT_FILES", bucket_name: "fixture-transit" }], triggers: { crons: ["* * * * *"] }, vars: { OOMOL_CONNECT_ORIGIN: "https://connector.example.test" } });
const options = { parentWorker: "shiba-preview-review", adapterImport: "../../../../packages/openconnector-read-gateway/src/upstream-adapter.ts" };

test("pure plan leaves original config intact, defaults off and creates no resource or credential", () => {
  const original = manual(), before = structuredClone(original), result = planReadGateway(original, options);
  assert.deepEqual(original, before); assert.equal(result.deploys, false); assert.equal(result.provisions, false); assert.equal(result.enabled, false);
  assert.equal(result.configPath, "wrangler.shiba-read.jsonc"); assert.equal(result.configuration.main, "src/server/shiba-read-entry.ts");
  assert.equal(result.configuration.vars.SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED, "false");
  assert.deepEqual(result.configuration.services, [{ binding: "SHIBA_AUTOMATIC_AUTHORITY", service: options.parentWorker }]);
  assert.deepEqual(result.configuration.version_metadata, { binding: "CF_VERSION_METADATA" });
  assert.deepEqual(result.configuration.d1_databases, original.d1_databases); assert.deepEqual(result.configuration.triggers, original.triggers); assert.deepEqual(result.configuration.assets, original.assets);
  assert.equal(result.configuration.compatibility_date, original.compatibility_date); assert.equal(result.configuration.observability.traces.enabled, true);
  assert(!JSON.stringify(result.configuration).includes("AGENT_AUDIT")); assert(!result.entry.includes("INTERNAL_SIGNING_KEY"));
});
test("wrapper uses the exact reviewed constructor/store APIs and delegates original manual fetch and scheduled handlers", () => {
  const entry = readGatewayEntry(options.adapterImport);
  for (const expected of ['from "./cloudflare.ts"', 'new D1RuntimeDatabase(database, { secretCodec })', 'new RuntimeTokenService(db.runtimeTokenStore)', 'db.connectionStore.get(service, alias)', 'tokens.resolveToken(token)', 'db.runtimePolicyStore.get()', 'new ActionPolicySnapshot(deployment, runtime, token, updatedAt)', 'upstream.scheduled(...args)', 'upstream.fetch(manual, env, ctx)']) assert(entry.includes(expected), expected);
  assert(!entry.includes("AGENT_AUDIT")); assert(!entry.includes("createToken(")); assert(!entry.includes("refreshToken(")); assert(!entry.includes("process.env"));
});
test("JSONC parsing preserves URLs, escaped quotes and string commas while supporting comments and trailing commas", () => {
  const value = parseReadGatewayConfig('{/*comment*/"url":"https://example.test/a//b", "quoted":"a\\\"//b", "text":"comma,}", "values":[1,2,], // final\n}');
  assert.deepEqual(value, { url: "https://example.test/a//b", quoted: 'a"//b', text: "comma,}", values: [1, 2] });
  assert.throws(() => parseReadGatewayConfig("{/*broken")); assert.throws(() => parseReadGatewayConfig("[]")); assert.throws(() => parseReadGatewayConfig("x".repeat(262145)));
});
test("an existing enabled read flag is not inherited into a newly prepared configuration", () => {
  const config = manual(); config.vars.SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED = "true";
  assert.equal(planReadGateway(config, options).configuration.vars.SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED, "false");
});
test("named environments cannot override the disabled flag or hide nested literal credentials", () => {
  assert.throws(() => planReadGateway({ ...manual(), env: { preview: { vars: { SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED: "true" } } } }, options), /Named environment/);
  assert.throws(() => planReadGateway({ ...manual(), env: { preview: { vars: { OOMOL_CONNECT_ENCRYPTION_KEY: "fixture-only" } } } }, options), /Named environment/);
});
test("manual entry, existing parent target and sibling storage selectors are required", () => {
  assert.throws(() => planReadGateway({ ...manual(), main: "src/server/other.ts" }, options));
  assert.throws(() => planReadGateway(manual(), { ...options, parentWorker: "../other" }));
  assert.throws(() => planReadGateway({ ...manual(), d1_databases: [] }, options));
  assert.throws(() => planReadGateway({ ...manual(), d1_databases: [{ binding: "AGENT_AUDIT", database_id: "11111111-1111-4111-8111-111111111111" }] }, options));
  assert.throws(() => readGatewayEntry("https://untrusted.test/upstream-adapter.ts"));
});
test("inline secret values and silent authority or version-binding replacement are refused", () => {
  for (const key of ["OOMOL_CONNECT_ADMIN_TOKEN", "OOMOL_CONNECT_ENCRYPTION_KEY", "INTERNAL_SIGNING_KEY", "VENDOR_PASSWORD"]) assert.throws(() => planReadGateway({ ...manual(), vars: { [key]: "fixture-only" } }, options), /Literal credentials/);
  assert.throws(() => planReadGateway({ ...manual(), services: [{ binding: "SHIBA_AUTOMATIC_AUTHORITY", service: "other" }] }, options));
  assert.throws(() => planReadGateway({ ...manual(), version_metadata: { binding: "OTHER_VERSION" } }, options));
});
test("all imported critical upstream source APIs are verified against the exact immutable blob hashes", () => {
  const fixture = JSON.parse(readFileSync(new URL("../packages/openconnector-read-gateway/test/fixtures/upstream-d89dc9.json", import.meta.url), "utf8"));
  verifyReadGatewayApi((path) => Buffer.from(fixture.files[path].content));
  assert.throws(() => verifyReadGatewayApi((path) => Buffer.from(fixture.files[path].content + "\nchanged")), /does not match/);
});
