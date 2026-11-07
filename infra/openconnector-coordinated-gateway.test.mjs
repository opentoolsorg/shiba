import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { coordinatedGatewayEntry, planCoordinatedGateway } from "./openconnector-coordinated-gateway.mjs";
const manual = { name: "fixture-connector", main: "src/server/cloudflare.ts", d1_databases: [{ binding: "DB", database_id: "11111111-1111-4111-8111-111111111111" }] };
const options = { parentWorker: "fixture-shiba", deploymentEpoch: "epoch-fixture-1", runtimeImport: "../../../packages/openconnector-read-gateway/src/operator-runtime.ts" };
test("coordinated plan has one stable owner, only append-only SQLite migration and no execution switch", () => {
  const copy = structuredClone(manual), plan = planCoordinatedGateway(copy, options); assert.deepEqual(copy, manual);
  assert.equal(plan.deploys, false); assert.equal(plan.provisions, false); assert.equal(plan.operatorExecutionEnabled, false);
  assert.deepEqual(plan.configuration.durable_objects, { bindings: [{ name: "SHIBA_CONNECTOR_OWNER", class_name: "ShibaOpenConnectorOwner" }] });
  assert.match(plan.entry, /const ownerName = "shiba-openconnector-owner-v1"/); assert.match(plan.entry, /this\.owner\.database\(env\.DB\)/);
  assert.match(plan.entry, /this\.owner\.nativeFetch/); assert.match(plan.entry, /this\.owner\.run/); assert.match(plan.entry, /operator_activation_unavailable/);
  assert.doesNotMatch(plan.entry, /OperatorGateway|SHIBA_OPERATOR_ENABLED|upstream\.fetch\(request, env/);
});
test("invalid imports, epochs, overrides, unreviewed DO and OAuth KV fail", () => {
  for (const changed of [{ env: { prod: {} } }, { durable_objects: { bindings: [{ name: "existing" }] } }, { migrations: [{ tag: "existing" }] }, { kv_namespaces: [{ binding: "OAUTH_KV" }] }]) assert.throws(() => planCoordinatedGateway({ ...manual, ...changed }, options));
  assert.throws(() => planCoordinatedGateway(manual, { ...options, deploymentEpoch: "" }));
  assert.throws(() => coordinatedGatewayEntry("https://external.test/src/operator-runtime.ts"));
});
test("operator source pins match every current runtime source", () => {
  const source = readFileSync(new URL("../packages/openconnector-read-gateway/src/operator-manifest.generated.ts", import.meta.url), "utf8");
  const hashes = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
  assert.equal(Object.keys(hashes).length, 6);
  for (const [path, expected] of Object.entries(hashes)) assert.equal(createHash("sha256").update(readFileSync(new URL(`../packages/openconnector-read-gateway/src/${path}`, import.meta.url))).digest("hex"), expected, path);
});
