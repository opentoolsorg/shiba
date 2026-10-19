#!/usr/bin/env node
/**
 * `.dev.vars.example` completeness — every Worker secret the operator may set
 * locally must appear as a commented `# KEY=` line in the example file, and
 * every key named there must exist on the optional `Env` interface.
 *
 * Source of required secret names: `@sensitive` entries in `.env.schema`
 * (minus Alchemy-only Cloudflare deploy credentials). Additional local-only
 * toggles and approver lists are listed in LOCAL_DEV_VARS below.
 *
 * Usage: node scripts/check-dev-vars-example.mjs
 *        [--example=<path>] [--env=<path>] [--schema=<path>]
 * Exit 0 when in sync; exit 1 with a drift report.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/check-dev-vars-example.mjs [options]

Options:
  --example=<path>  example file (default: apps/backend/.dev.vars.example)
  --env=<path>      Env interface (default: apps/backend/src/env.ts)
  --schema=<path>   varlock schema (default: .env.schema)
  --help            show this text`);
  process.exit(0);
}

const examplePath = resolve(root, arg("example") ?? "apps/backend/.dev.vars.example");
const envPath = resolve(root, arg("env") ?? "apps/backend/src/env.ts");
const schemaPath = resolve(root, arg("schema") ?? ".env.schema");

/** Local `.dev.vars` keys that are not @sensitive in `.env.schema` but belong in the example. */
const LOCAL_DEV_VARS = new Set([
  "ACCESS_AUD",
  "DASHBOARD_APPROVERS",
  "DISCORD_APPROVERS",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_REPOS",
  "GITHUB_API_BASE",
  "GITHUB_PROJECT_NUMBER",
  "PAIRING_SECRET",
  "REQUIRE_ACCESS",
  "SHIBA_LOCAL_RUNTIME",
  "TRIGGER_TOKEN",
]);

/** Alchemy deploy credentials — documented in `.env.schema`, not wrangler `.dev.vars`. */
const SCHEMA_SENSITIVE_SKIP = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);

function collectEnvOptionalFields(text) {
  const head = text.match(/export\s+interface\s+Env\s*(?:extends\s+[^{]+?)?\s*\{/);
  if (!head || head.index === undefined) throw new Error("no `export interface Env` found");
  const start = head.index + head[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("unbalanced braces in interface Env");
  const body = text.slice(start + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const optional = new Set();
  let memberDepth = 0;
  let pending = "";
  const takeMember = (seg) => {
    const m = seg.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:/);
    if (m && m[2] === "?") optional.add(m[1]);
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "");
    for (const ch of line) {
      if (memberDepth === 0) {
        if (ch === ";") {
          takeMember(pending);
          pending = "";
          continue;
        }
        if (ch === "{") memberDepth++;
        else if (ch === "}") memberDepth--;
        pending += ch;
      } else {
        if (ch === "{") memberDepth++;
        else if (ch === "}") memberDepth--;
      }
    }
  }
  takeMember(pending);
  return optional;
}

function collectSchemaSensitiveKeys(text) {
  const keys = new Set();
  const lines = text.split("\n");
  let pendingSensitive = false;
  for (const line of lines) {
    if (line.includes("@sensitive")) pendingSensitive = true;
    const m = line.match(/^([A-Z][A-Z0-9_]+)=/);
    if (m) {
      if (pendingSensitive && !SCHEMA_SENSITIVE_SKIP.has(m[1])) keys.add(m[1]);
      pendingSensitive = false;
    }
  }
  return keys;
}

function collectExampleKeys(text) {
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^(?:#\s*)?([A-Z][A-Z0-9_]+)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

let envOptional;
let exampleText;
let schemaText;
try {
  envOptional = collectEnvOptionalFields(readFileSync(envPath, "utf8"));
  exampleText = readFileSync(examplePath, "utf8");
  schemaText = readFileSync(schemaPath, "utf8");
} catch (err) {
  console.error(`check-dev-vars-example: ${err.message}`);
  process.exit(1);
}

const exampleKeys = collectExampleKeys(exampleText);
const required = new Set([...collectSchemaSensitiveKeys(schemaText), ...LOCAL_DEV_VARS]);

const drift = [];
for (const key of required) {
  if (!exampleKeys.has(key)) {
    drift.push(`missing from ${examplePath}: ${key} (add a commented "# ${key}=" line)`);
  }
}
for (const key of exampleKeys) {
  if (!envOptional.has(key)) {
    drift.push(`stale in ${examplePath}: ${key} is not an optional Env field`);
  }
}

if (drift.length > 0) {
  for (const line of drift) console.error(`check-dev-vars-example: ${line}`);
  process.exit(1);
}
console.log(
  `check-dev-vars-example: .dev.vars.example documents ${exampleKeys.size} keys (${required.size} required)`,
);
