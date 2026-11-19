#!/usr/bin/env node
/**
 * Points apps/backend/wrangler.dogfood.jsonc at a prebuilt sandbox image.
 * Takes the digest (or full reference) printed by the Build sandbox image
 * workflow; the account and repository are read from the pin already in the
 * file, so only the digest moves.
 *
 *   node scripts/pin-dogfood-image.mjs sha256:...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = /(registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9._-]+)@sha256:[a-f0-9]{64}/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function pinnedReference(source) {
  return source.match(PIN)?.[0] ?? null;
}

/** Rewrites the pin to `digest`, keeping the account and repository. */
export function pinImage(source, digest) {
  if (!DIGEST.test(digest)) throw new Error(`not a sha256 image digest: ${digest}`);
  const current = source.match(PIN);
  if (!current) throw new Error("no managed-registry image pin found in the dogfood config");
  return source.replace(PIN, `${current[1]}@${digest}`);
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = resolve(root, "apps/backend/wrangler.dogfood.jsonc");
  const input = argv[2];
  if (!input) {
    console.error("usage: node scripts/pin-dogfood-image.mjs <sha256:digest | full image reference>");
    process.exit(2);
  }
  const digest = input.startsWith("sha256:") ? input : input.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!digest) {
    console.error(`not a sha256 image digest: ${input}`);
    process.exit(2);
  }
  const source = readFileSync(configPath, "utf8");
  const pinned = `${pinnedReference(pinImage(source, digest))}`;
  if (pinned === pinnedReference(source)) {
    console.log(`already pinned: ${pinned}`);
    return;
  }
  writeFileSync(configPath, pinImage(source, digest));
  console.log(`pinned ${pinned}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
