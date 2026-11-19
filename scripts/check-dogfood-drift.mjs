#!/usr/bin/env node
/**
 * Ensures wrangler.dogfood.jsonc binding *names* (and queue/workflow/ratelimit
 * identifiers) stay aligned with apps/backend/wrangler.jsonc. Resource ids and
 * hostnames may differ between stacks.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && n !== undefined) {
        out += n;
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
  return out.replace(/,\s*([}\]])/g, "$1");
}

function load(path) {
  return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

function bindingNames(cfg) {
  const names = new Set();
  for (const row of cfg.durable_objects?.bindings ?? []) names.add(row.name);
  for (const row of cfg.r2_buckets ?? []) names.add(row.binding);
  for (const row of cfg.kv_namespaces ?? []) names.add(row.binding);
  for (const row of cfg.d1_databases ?? []) names.add(row.binding);
  for (const row of cfg.vectorize ?? []) names.add(row.binding);
  for (const row of cfg.worker_loaders ?? []) names.add(row.binding);
  if (cfg.ai?.binding) names.add(cfg.ai.binding);
  if (cfg.browser?.binding) names.add(cfg.browser.binding);
  if (cfg.assets?.binding) names.add(cfg.assets.binding);
  if (cfg.version_metadata?.binding) names.add(cfg.version_metadata.binding);
  for (const row of cfg.send_email ?? []) names.add(row.name);
  for (const row of cfg.ratelimits ?? []) names.add(row.name);
  for (const row of cfg.queues?.producers ?? []) names.add(row.binding);
  for (const row of cfg.workflows ?? []) names.add(row.binding);
  for (const row of cfg.services ?? []) names.add(row.binding);
  return names;
}

/**
 * The dogfood Worker was deployed by the declarative `exports` flow (alchemy),
 * and Cloudflare refuses to revert a Worker to `migrations` (code 100403), so
 * this config must keep declaring its Durable Object classes in `exports` and
 * must never carry a `migrations` array again.
 */
export function durableObjectProblems(cfg) {
  const problems = [];
  if (cfg.migrations !== undefined) {
    problems.push(
      "declares \"migrations\"; the deployed Worker uses the declarative exports flow and Cloudflare refuses to revert to migrations (100403). Declare Durable Object classes in \"exports\".",
    );
  }
  const exports = cfg.exports ?? {};
  if (!Object.keys(exports).length) {
    problems.push('has no "exports" block; the deployed Worker declares its Durable Object classes there.');
  }
  const exported = new Set(
    Object.entries(exports)
      .filter(([, entry]) => entry?.type === "durable-object" && (entry.state ?? "created") === "created")
      .map(([name]) => name),
  );
  const bound = new Set((cfg.durable_objects?.bindings ?? []).map((b) => b.class_name));
  for (const name of bound) {
    if (!exported.has(name)) problems.push(`binds Durable Object class "${name}" with no live "exports" entry.`);
  }
  for (const name of exported) {
    if (!bound.has(name)) problems.push(`exports Durable Object class "${name}" that no binding references.`);
  }
  const containerNames = new Set((cfg.containers ?? []).map((c) => c.name));
  for (const [name, entry] of Object.entries(exports)) {
    if (entry?.container !== undefined && !containerNames.has(entry.container)) {
      problems.push(`exports "${name}" with container "${entry.container}", which is not a containers[] name.`);
    }
  }
  return problems;
}

/**
 * Workers Builds deploys wrangler.dogfood.jsonc, so a container image it
 * builds there uploads the whole sandbox image (~3.3 GB of layers, one of them
 * 1.72 GB) from inside the build, and the registry upload times out. The image
 * must therefore be digest-pinned to what .github/workflows/
 * build-sandbox-image.yml pushes, never built by the deploy.
 */
export function containerImageProblems(cfg) {
  const problems = [];
  for (const container of cfg.containers ?? []) {
    const images = Object.entries(container.images ?? {});
    if (!images.length) {
      problems.push(
        `container "${container.name}" has no images entry; pin a registry digest from build-sandbox-image.yml`,
      );
    }
    for (const [imageName, image] of images) {
      const field = `container "${container.name}" images.${imageName}`;
      if (image?.dockerfile !== undefined) {
        problems.push(
          `${field} builds ${image.dockerfile} during the deploy; Workers Builds cannot push the sandbox image from the build. Pin a digest pushed by build-sandbox-image.yml.`,
        );
        continue;
      }
      if (!MANAGED_IMAGE.test(image?.image ?? "")) {
        problems.push(
          `${field} must be a digest-pinned managed image (registry.cloudflare.com/<account>/<repository>@sha256:<64 hex>), found ${JSON.stringify(image?.image ?? null)}`,
        );
      }
    }
  }
  return problems;
}

const MANAGED_IMAGE =
  /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*@sha256:[a-f0-9]{64}$/;

function main() {
  const mainPath = resolve(root, "apps/backend/wrangler.jsonc");
  const dogfoodPath = resolve(root, "apps/backend/wrangler.dogfood.jsonc");
  const main = load(mainPath);
  const dogfood = load(dogfoodPath);
  const mainNames = bindingNames(main);
  const dogfoodNames = bindingNames(dogfood);
  const missing = [...mainNames].filter((n) => !dogfoodNames.has(n)).sort();
  const extra = [...dogfoodNames].filter((n) => !mainNames.has(n)).sort();
  if (missing.length || extra.length) {
    console.error("wrangler.dogfood.jsonc drift:");
    if (missing.length) console.error("  missing bindings:", missing.join(", "));
    if (extra.length) console.error("  unexpected bindings:", extra.join(", "));
    process.exit(1);
  }
  if (!dogfood.containers?.length) {
    console.error("wrangler.dogfood.jsonc must declare a Sandbox containers[] entry.");
    process.exit(1);
  }
  const imageProblems = containerImageProblems(dogfood);
  if (imageProblems.length) {
    console.error("wrangler.dogfood.jsonc container image drift:");
    for (const problem of imageProblems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const durableProblems = durableObjectProblems(dogfood);
  if (durableProblems.length) {
    console.error("wrangler.dogfood.jsonc Durable Object flow drift:");
    for (const problem of durableProblems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`dogfood bindings: ${dogfoodNames.size} names aligned with wrangler.jsonc`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
