#!/usr/bin/env node
// Historical dry-run diagnostics only; the former shared-binding apply path is retired.
// Actual preview deployment and teardown use scripts/deploy.mjs.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(`Legacy dry-run diagnostic only. Apply moved to scripts/deploy.mjs --stage=pr-<number>.
Usage: node scripts/ephemeral-stack.mjs --dry-run [options]

Options:
  --alchemy                drive the alchemy CLI: deploy --stage <prefix>,
                           smoke, then destroy --stage <prefix> (primary)
  --prefix=<name>          stage/worker suffix (default: test-<unix-ts>)
  --wrangler=<path>        base wrangler config (wrangler mode only;
                           default: apps/backend/wrangler.jsonc)
  --smoke-timeout-ms=<n>   smoke-test fetch timeout (default: 15000)
  --keep                   skip teardown (leave the ephemeral stage live)
  --dry-run                print the plan without executing anything
  --help                   show this text

Alchemy mode runs alchemy deploy --stage <prefix> --yes with
ALCHEMY_STAGE=<prefix> in the child env (the stage-suffixed worker name
shiba-ai-coworker-<prefix> comes from alchemy.run.ts). Wrangler mode writes
apps/backend/.wrangler-ephemeral-<prefix>.jsonc, runs wrangler deploy --config <tmp>,
then wrangler delete --config <tmp>. Both smoke-test GET / — the worker
has no /healthz; any HTTP status (incl. the Access-gate 401) counts.`);
  process.exit(0);
}

// --- JSONC: two string-aware passes — strip comments BEFORE trailing commas.
function stripJsoncComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) out += n;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) out += n;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const parseJsonc = (text) => JSON.parse(stripTrailingCommas(stripJsoncComments(text)));

const useAlchemy = flag("alchemy");
const prefix = arg("prefix") ?? `test-${Math.floor(Date.now() / 1000)}`;
if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
  console.error(`ephemeral-stack: invalid --prefix "${prefix}" (lowercase dns-safe required)`);
  process.exit(1);
}
const wranglerPath = resolve(root, arg("wrangler") ?? "apps/backend/wrangler.jsonc");
const smokeTimeoutMs = Number(arg("smoke-timeout-ms") ?? 15_000);
const dryRun = flag("dry-run");
const keep = flag("keep");

const log = (msg) => console.log(`[ephemeral] ${msg}`);

let cfg;
try {
  cfg = parseJsonc(readFileSync(wranglerPath, "utf8"));
} catch (err) {
  console.error(`ephemeral-stack: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

const baseName = cfg.name;
const workerName = `${baseName}-${prefix}`;
// Lives in apps/backend/ — wrangler resolves main/assets/image relative to the
// config file's own directory.
const tmpConfig = resolve(root, "apps", "backend", `.wrangler-ephemeral-${prefix}.jsonc`);

// Alchemy mode: --stage <prefix> drives alchemy.run.ts; ALCHEMY_STAGE in
// the child env makes the config's stage-conditional name resolve to the
// same shiba-ai-coworker-<prefix> the wrangler mode writes into its temp config.
const deployCmd = useAlchemy
  ? `npx alchemy deploy --stage ${prefix} --yes`
  : `npx wrangler deploy --config ${tmpConfig}`;
const deleteCmd = useAlchemy
  ? `npx alchemy destroy --stage ${prefix} --yes`
  : `npx wrangler delete --config ${tmpConfig} --name ${workerName}`;

if (dryRun) {
  log(`prefix ${prefix} -> worker name ${workerName}`);
  if (useAlchemy) {
    log(`stage ${prefix} (ALCHEMY_STAGE exported to the child; name suffix comes from alchemy.run.ts)`);
    log(`would run: ALCHEMY_STAGE=${prefix} ${deployCmd}`);
  } else {
    log(`would write temp config ${tmpConfig} (name="${workerName}", preview_urls=false)`);
    log(`would run: ${deployCmd}`);
  }
  log(`would smoke-test: GET https://${workerName}.<subdomain>.workers.dev/ (any HTTP status = reachable; timeout ${smokeTimeoutMs}ms)`);
  if (keep) log("--keep: teardown skipped");
  else log(`would run: ${useAlchemy ? `ALCHEMY_STAGE=${prefix} ` : ""}${deleteCmd}`);
  process.exit(0);
}

console.error("Ephemeral apply retired: use scripts/deploy.mjs --stage=pr-<number>; close the PR for guarded teardown.");
process.exit(1);
