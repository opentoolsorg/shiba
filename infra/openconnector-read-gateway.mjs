#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { revision, release } from "./openconnector.mjs";

export const upstreamReadApi = Object.freeze({
  "src/server/cloudflare.ts": "367270323d06ba66c972ab6c570b56aff0dfd5f1",
  "src/server/secrets/worker-secret-codec.ts": "08c1e5e18087d7b5a61b1d3f12a0ec6d41f98626",
  "src/server/secrets/secret-codec-core.ts": "4093c1aba196e78984f36f009cfa5d42c899650e",
  "src/server/storage/d1/runtime-store.ts": "62b14e270f7bc9af5ec9df7c158902408372c375",
  "src/server/storage/connection-store.ts": "b7e4d635afc4b4bb3ace75d4fa2870c6248892fb",
  "src/server/storage/runtime-token-service.ts": "60885c309a87f7386388b60fbfbfcf7c94a7eeac",
  "src/core/action-policy.ts": "3c3a51ec3136dd80a70a38f293a8fbad03cf8989",
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerName = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(value);
const blob = (value) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");

/** Parse bounded JSONC without executing config code or altering strings such as HTTPS URLs. */
export function parseReadGatewayConfig(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 262144) throw new Error("Configuration exceeds the local plan limit");
  let cleaned = "", quoted = false, escaped = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at], next = text[at + 1];
    if (quoted) { cleaned += char; if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; cleaned += char; }
    else if (char === "/" && next === "/") { while (at < text.length && text[at] !== "\n") at++; cleaned += "\n"; }
    else if (char === "/" && next === "*") { const end = text.indexOf("*/", at + 2); if (end === -1) throw new Error("Unclosed JSONC comment"); at = end + 1; cleaned += " "; }
    else cleaned += char;
  }
  let json = ""; quoted = false; escaped = false;
  for (let at = 0; at < cleaned.length; at++) {
    const char = cleaned[at];
    if (quoted) { json += char; if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    if (char === "," && /^[\s]*[}\]]/.test(cleaned.slice(at + 1))) continue;
    json += char;
  }
  const result = JSON.parse(json);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Expected a Worker configuration object");
  return result;
}

export function readGatewayEntry(adapterImport) {
  if (typeof adapterImport !== "string" || !adapterImport.endsWith("/src/upstream-adapter.ts") || !adapterImport.startsWith(".")) throw new Error("Expected an explicit local gateway adapter import");
  return `// Generated local opt-in entry. Original pinned upstream sources and manual entry remain unmodified.
import upstream from "./cloudflare.ts";
import type { CloudflareEnv } from "./cloudflare/cloudflare-env.ts";
import { createWorkerSecretCodec } from "./secrets/worker-secret-codec.ts";
import { D1RuntimeDatabase } from "./storage/d1/runtime-store.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { ActionPolicySnapshot, emptyPolicyRules, parseActionPolicyList } from "../core/action-policy.ts";
import { handlePinnedUpstreamReadGateway, type PinnedReadGatewayEnv, type PinnedUpstreamModules } from ${JSON.stringify(adapterImport)};

type Database = CloudflareEnv["DB"];
type Env = CloudflareEnv & PinnedReadGatewayEnv<Database>;
const modules: PinnedUpstreamModules<Database> = {
  createWorkerSecretCodec, emptyPolicyRules, parseActionPolicyList,
  createReadContext(database, secretCodec) {
    const db = new D1RuntimeDatabase(database, { secretCodec });
    const tokens = new RuntimeTokenService(db.runtimeTokenStore);
    return {
      getConnection: (service, alias) => db.connectionStore.get(service, alias),
      resolveRuntimeToken: (token) => tokens.resolveToken(token),
      getRuntimePolicy: () => db.runtimePolicyStore.get(),
    };
  },
  createPolicy: (deployment, runtime, token, updatedAt) => new ActionPolicySnapshot(deployment, runtime, token, updatedAt),
};
export default {
  scheduled: (...args: Parameters<typeof upstream.scheduled>) => upstream.scheduled(...args),
  fetch(request: Request, env: Env, ctx: Parameters<typeof upstream.fetch>[2]) {
    return handlePinnedUpstreamReadGateway(request, env, modules, (manual) => upstream.fetch(manual, env, ctx));
  },
};
`;
}

/** Pure plan only. Resource IDs and existing secret bindings remain operator-managed. */
export function planReadGateway(manual, { parentWorker, adapterImport }) {
  if (!manual || typeof manual !== "object" || Array.isArray(manual) || manual.main !== "src/server/cloudflare.ts" || !workerName(manual.name)) throw new Error("Expected the configured pinned upstream manual Worker entry");
  if (manual.env && Object.keys(manual.env).length) throw new Error("Named environment overrides are not supported; select one explicit standalone manual configuration before planning");
  if (!workerName(parentWorker)) throw new Error("Select the exact existing parent Worker for the reverse authority binding");
  if (!Array.isArray(manual.d1_databases) || manual.d1_databases.length !== 1 || manual.d1_databases[0]?.binding !== "DB" || !/^[a-f0-9-]{36}$/i.test(manual.d1_databases[0]?.database_id ?? "")) throw new Error("The sibling's existing DB binding is required; parent audit storage is forbidden");
  if (Object.keys(manual.vars ?? {}).some((name) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)KEY)(?:$|_)/i.test(name))) throw new Error("Literal credentials are forbidden in the configuration plan; use existing Worker secrets");
  if (Array.isArray(manual.services) && manual.services.some((item) => item.binding === "SHIBA_AUTOMATIC_AUTHORITY")) throw new Error("Review the existing authority binding separately rather than replacing it");
  if (manual.version_metadata && manual.version_metadata.binding !== "CF_VERSION_METADATA") throw new Error("Preserve the existing platform version binding before adding this plan");
  const configuration = structuredClone(manual);
  configuration.main = "src/server/shiba-read-entry.ts";
  configuration.vars = { ...configuration.vars, SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED: "false" };
  configuration.version_metadata = { binding: "CF_VERSION_METADATA" };
  configuration.services = [...(configuration.services ?? []), { binding: "SHIBA_AUTOMATIC_AUTHORITY", service: parentWorker }];
  configuration.observability = { ...configuration.observability, enabled: true, traces: { ...configuration.observability?.traces, enabled: true } };
  return { upstreamRevision: revision, deploys: false, provisions: false, enabled: false,
    conditionalSecrets: [{ operation: "googleads.campaign_daily_metrics", binding: "SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY", worker: "existing-sibling-only", generated: false,
      requirement: "Operator-provisioned cryptographically random base64url key, 43–128 characters with at least 16 distinct characters. Rotation invalidates Google Ads grants." }],
    entryPath: "src/server/shiba-read-entry.ts", configPath: "wrangler.shiba-read.jsonc", entry: readGatewayEntry(adapterImport), configuration,
    nextStep: "Review the separate configuration, exact platform version and generated manifest pin. No credential, resource, deployment or feature activation is performed by this helper." };
}

export function verifyReadGatewayApi(read) {
  for (const [file, expected] of Object.entries(upstreamReadApi)) {
    const bytes = read(file);
    if (!Buffer.isBuffer(bytes) || blob(bytes) !== expected) throw new Error(`Pinned upstream API file does not match: ${file}`);
  }
}
export function verifyReadGatewayCheckout(checkout) {
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  if (actual !== revision || execFileSync("git", ["diff", "HEAD", "--"], { cwd: checkout, encoding: "utf8" }).trim()) throw new Error("The upstream checkout must be clean at the exact reviewed revision");
  verifyReadGatewayApi((file) => readFileSync(resolve(checkout, file)));
}

function main() {
  const [command, parentWorker] = process.argv.slice(2);
  if (!["plan", "prepare"].includes(command) || !parentWorker) throw new Error("Usage: node infra/openconnector-read-gateway.mjs plan|prepare EXISTING_PARENT_WORKER. This never deploys or provisions.");
  const checkout = resolve(root, ".openconnector", release); verifyReadGatewayCheckout(checkout);
  const entry = resolve(checkout, "src/server/shiba-read-entry.ts"), target = resolve(root, "packages/openconnector-read-gateway/src/upstream-adapter.ts");
  const adapterImport = relative(dirname(entry), target).split(sep).join("/");
  const plan = planReadGateway(parseReadGatewayConfig(readFileSync(resolve(checkout, "wrangler.local.jsonc"), "utf8")), { parentWorker, adapterImport });
  if (command === "plan") { console.log(JSON.stringify(plan, null, 2)); return; }
  const config = resolve(checkout, plan.configPath);
  if (existsSync(entry) || existsSync(config)) throw new Error("Existing generated files are preserved; review or remove only those local files before preparing again");
  writeFileSync(entry, plan.entry, { flag: "wx", mode: 0o600 });
  try { writeFileSync(config, JSON.stringify(plan.configuration, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("The local entry was written but its separate configuration could not be created. Review that entry before retrying; nothing was deployed."); }
  console.log("Prepared two separate local files with scheduled reads disabled. Original manual configuration is unchanged; nothing was deployed or provisioned.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
