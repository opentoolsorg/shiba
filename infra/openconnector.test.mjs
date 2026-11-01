import assert from "node:assert/strict";
import test from "node:test";
import { configure, deploy, release, revision } from "./openconnector.mjs";

const example = JSON.stringify({
  name: "open-connector", main: "src/server/cloudflare.ts",
  triggers: { crons: ["* * * * *"] },
  assets: { directory: "dist/web", binding: "ASSETS" },
  d1_databases: [{ binding: "DB", database_name: "open-connector", database_id: "<your-d1-database-id>", migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "TRANSIT_FILES", bucket_name: "<your-bucket-name>" }],
}, null, 2);
const databaseId = "12345678-1234-1234-1234-123456789abc";

test("configuration retains upstream bindings, cron, migrations and assets", () => {
  const config = JSON.parse(configure(example, { databaseId, origin: "https://connect.example.com" }));
  assert.equal(config.name, "shiba-openconnector");
  assert.equal(config.d1_databases[0].database_id, databaseId);
  assert.equal(config.d1_databases[0].migrations_dir, "migrations");
  assert.equal(config.r2_buckets[0].binding, "TRANSIT_FILES");
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.vars.OOMOL_CONNECT_ORIGIN, "https://connect.example.com");
});

test("configuration rejects missing D1 IDs and malformed resource names/origins", () => {
  assert.throws(() => configure(example, {}), /D1/);
  assert.throws(() => configure(example, { databaseId }), /OOMOL_CONNECT_ORIGIN/);
  assert.throws(() => configure(example, { databaseId, worker: "../bad" }), /Invalid/);
  assert.throws(() => configure(example, { databaseId, origin: "http://example.com" }), /HTTPS/);
  assert.throws(() => configure(example, { databaseId, origin: "https://example.com/" }), /HTTPS/);
});

test("KV replaces the R2 transit binding and enables its backend", () => {
  const config = JSON.parse(configure(example, { databaseId, backend: "kv", namespaceId: "a".repeat(32), origin: "https://connect.example.com" }));
  assert.equal(config.r2_buckets, undefined);
  assert.deepEqual(config.kv_namespaces, [{ binding: "TRANSIT_FILES", id: "a".repeat(32) }]);
  assert.equal(config.vars.TRANSIT_FILES_BACKEND, "kv");
  assert.throws(() => configure(example, { databaseId, backend: "kv" }), /KV/);
  assert.throws(() => configure(example, { databaseId, backend: "invalid" }), /must be r2 or kv/);
});

test("deploy applies migrations before the pinned upstream build", () => {
  assert.equal(release, "v1.9.4");
  assert.match(revision, /^[a-f0-9]{40}$/);
  const calls = [];
  deploy((args) => calls.push(args), (command, args) => calls.push([command, ...args]));
  assert.deepEqual(calls, [
    ["d1", "migrations", "apply", "shiba-openconnector", "--remote", "--config", "wrangler.local.jsonc"],
    ["npm", "run", "deploy:cloudflare"],
  ]);
});

test("a failed migration prevents the Worker build and deploy", () => {
  let deployed = false;
  assert.throws(() => deploy(() => { throw new Error("migration failed"); }, () => { deployed = true; }), /migration failed/);
  assert.equal(deployed, false);
});
