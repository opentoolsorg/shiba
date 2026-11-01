import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configure, release, revision } from "./openconnector.mjs";

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

test("deploy runs pinned upstream build independently from migrations", () => {
  assert.equal(release, "v1.9.4");
  assert.match(revision, /^[a-f0-9]{40}$/);
  const source = readFileSync(new URL("./openconnector.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(command === "deploy"\) run\("npm", \["run", "deploy:cloudflare"\]\)/);
  assert.match(source, /if \(command === "apply-d1"\) wrangler\(\["d1", "migrations", "apply"/);
});
