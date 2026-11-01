#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const release = "v1.9.4";
export const revision = "d89dc9f24f5a057bb500272d7dbf333837c77c68";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(root, ".openconnector", release);
const run = (command, args, cwd = checkout) => execFileSync(command, args, { cwd, stdio: "inherit" });

export function configure(example, { databaseId, worker = "shiba-openconnector", bucket = "shiba-openconnector-transit", backend = "r2", namespaceId, origin }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId ?? "")) throw new Error("Set OPEN_CONNECTOR_D1_ID to the provisioned D1 database UUID");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(worker) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid Worker or R2 bucket name");
  if (!["r2", "kv"].includes(backend)) throw new Error("OPEN_CONNECTOR_TRANSIT_BACKEND must be r2 or kv");
  if (backend === "kv" && !/^[a-f0-9]{32}$/i.test(namespaceId ?? "")) throw new Error("Set OPEN_CONNECTOR_KV_ID to the transit KV namespace ID");
  let config = example.replace('"name": "open-connector"', `"name": ${JSON.stringify(worker)}`)
    .replace('"database_name": "open-connector"', '"database_name": "shiba-openconnector"')
    .replace('"<your-d1-database-id>"', JSON.stringify(databaseId))
    .replace('"<your-bucket-name>"', JSON.stringify(bucket));
  if (backend === "kv") {
    config = config.replace(/"r2_buckets":\s*\[[\s\S]*?\]/, `"kv_namespaces": [{ "binding": "TRANSIT_FILES", "id": ${JSON.stringify(namespaceId)} }]`);
  }
  // Bound requests have an internal origin; upstream needs its public origin for OAuth and files.
  if (!origin) throw new Error("Set OOMOL_CONNECT_ORIGIN to the sibling public HTTPS origin");
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) throw new Error("OOMOL_CONNECT_ORIGIN must be an HTTPS origin without a trailing slash");
    const vars = { OOMOL_CONNECT_ORIGIN: origin, ...(backend === "kv" ? { TRANSIT_FILES_BACKEND: "kv" } : {}) };
    config = config.replace('"triggers":', `"vars": ${JSON.stringify(vars)},\n  "triggers":`);
  }
  return config;
}

function verifyCheckout() {
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  if (actual !== revision) throw new Error(`Upstream ${release} does not match pinned revision`);
  if (execFileSync("git", ["diff", "HEAD", "--"], { cwd: checkout, encoding: "utf8" }).trim()) throw new Error("Upstream tracked files were modified; restore them before continuing");
}

// Applying pending migrations is idempotent; a failed migration must prevent deployment.
export function deploy(wrangler, npm = run) {
  wrangler(["d1", "migrations", "apply", "shiba-openconnector", "--remote", "--config", "wrangler.local.jsonc"]);
  npm("npm", ["run", "deploy:cloudflare"]);
}

function main() {
  const command = process.argv[2];
  if (!["prepare", "provision", "configure", "apply-d1", "deploy", "secret"].includes(command)) {
    console.log("Usage: node infra/openconnector.mjs prepare|provision|configure|apply-d1|deploy|secret NAME\nSee docs/OPENCONNECTOR.md. Deploy applies pending D1 migrations first; provision creates remote resources.");
    return;
  }
  if (command === "prepare") {
    mkdirSync(dirname(checkout), { recursive: true });
    if (!existsSync(resolve(checkout, ".git"))) run("git", ["clone", "--depth", "1", "--branch", release, "https://github.com/oomol-lab/open-connector.git", checkout], root);
    verifyCheckout();
    run("npm", ["ci"]);
    console.log(`Prepared unmodified upstream ${release} (${revision}) at ${checkout}`);
    return;
  }
  if (!existsSync(resolve(checkout, "node_modules"))) throw new Error("Run pnpm prepare:openconnector first");
  verifyCheckout();
  const wrangler = (args) => run("npm", ["exec", "--", "wrangler", ...args]);
  if (command === "provision") {
    const backend = process.env.OPEN_CONNECTOR_TRANSIT_BACKEND || "r2";
    if (!["r2", "kv"].includes(backend)) throw new Error("OPEN_CONNECTOR_TRANSIT_BACKEND must be r2 or kv");
    wrangler(["d1", "create", "shiba-openconnector"]);
    if (backend === "kv") wrangler(["kv", "namespace", "create", "shiba-openconnector-transit"]);
    else wrangler(["r2", "bucket", "create", process.env.OPEN_CONNECTOR_R2_BUCKET || "shiba-openconnector-transit"]);
    console.log("Copy the database_id into OPEN_CONNECTOR_D1_ID, then run pnpm configure:openconnector");
    return;
  }
  if (command === "configure") {
    writeFileSync(resolve(checkout, "wrangler.local.jsonc"), configure(readFileSync(resolve(checkout, "wrangler.example.jsonc"), "utf8"), {
      databaseId: process.env.OPEN_CONNECTOR_D1_ID,
      worker: process.env.OPEN_CONNECTOR_WORKER || "shiba-openconnector",
      bucket: process.env.OPEN_CONNECTOR_R2_BUCKET || "shiba-openconnector-transit",
      backend: process.env.OPEN_CONNECTOR_TRANSIT_BACKEND || "r2",
      namespaceId: process.env.OPEN_CONNECTOR_KV_ID,
      origin: process.env.OOMOL_CONNECT_ORIGIN,
    }));
    return;
  }
  if (!existsSync(resolve(checkout, "wrangler.local.jsonc"))) throw new Error("Run pnpm configure:openconnector first");
  if (command === "apply-d1") wrangler(["d1", "migrations", "apply", "shiba-openconnector", "--remote", "--config", "wrangler.local.jsonc"]);
  if (command === "deploy") deploy(wrangler);
  if (command === "secret") {
    const name = process.argv[3];
    if (!["OOMOL_CONNECT_ADMIN_TOKEN", "OOMOL_CONNECT_ENCRYPTION_KEY"].includes(name)) throw new Error("Unsupported secret name");
    wrangler(["secret", "put", name, "--config", "wrangler.local.jsonc"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
