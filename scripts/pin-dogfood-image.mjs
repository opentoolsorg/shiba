#!/usr/bin/env node
/**
 * Points apps/backend/wrangler.dogfood.jsonc at a prebuilt sandbox image.
 *
 *   node scripts/pin-dogfood-image.mjs registry.cloudflare.com/<account>/<repo>@sha256:...
 *   node scripts/pin-dogfood-image.mjs sha256:...
 *
 * A full reference replaces the repository and the digest, which is what the
 * Build sandbox image workflow prints. A bare digest moves only the digest and
 * keeps the repository already pinned.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "registry\\.cloudflare\\.com\\/[a-f0-9]{32}\\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const PIN = new RegExp(`${REPOSITORY}@sha256:[a-f0-9]{64}`);
const FULL_REFERENCE = new RegExp(`^(${REPOSITORY})@(sha256:[a-f0-9]{64})$`);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function pinnedReference(source) {
  return source.match(PIN)?.[0] ?? null;
}

/** Rewrites the pin to `reference`: a full managed-registry reference or a bare digest. */
export function pinImage(source, reference) {
  const current = source.match(PIN)?.[0];
  if (!current) throw new Error("no managed-registry image pin found in the dogfood config");
  if (DIGEST.test(reference)) {
    return source.replace(PIN, `${current.slice(0, current.indexOf("@"))}@${reference}`);
  }
  if (!FULL_REFERENCE.test(reference)) {
    throw new Error(`not a managed-registry image reference: ${reference}`);
  }
  return source.replace(PIN, reference);
}

/** The reference a full-reference argument or bare digest resolves to. */
export function resolvedReference(source, reference) {
  return pinnedReference(pinImage(source, reference));
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = resolve(root, "apps/backend/wrangler.dogfood.jsonc");
  const reference = argv[2];
  if (!reference) {
    console.error("usage: node scripts/pin-dogfood-image.mjs <full image reference | sha256:digest>");
    process.exit(2);
  }
  const source = readFileSync(configPath, "utf8");
  const pinned = resolvedReference(source, reference);
  if (pinned === pinnedReference(source)) {
    console.log(`already pinned: ${pinned}`);
    return;
  }
  writeFileSync(configPath, pinImage(source, reference));
  console.log(`pinned ${pinned}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
