import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Workers Builds runs wrangler from the repo root: the deploy step needs both a
// `previews` block in the resolved config and root discovery of the backend
// config via .wrangler/deploy/config.json written by assemble-public.

test("every backend wrangler config declares a previews block", () => {
  for (const name of ["wrangler.jsonc", "wrangler.dogfood.jsonc", "wrangler.noroutes.tmp.jsonc"]) {
    const source = readFileSync(`apps/backend/${name}`, "utf8");
    assert.match(source, /"previews"\s*:\s*\{/, `${name} is missing a previews block`);
  }
});

test("assemble-public writes root wrangler discovery to the backend config", () => {
  const source = readFileSync("scripts/assemble-public.mjs", "utf8");
  assert.match(source, /\.wrangler\/deploy\//);
  assert.match(source, /config\.json/);
  assert.match(source, /apps\/backend\/wrangler\.jsonc/);
});
