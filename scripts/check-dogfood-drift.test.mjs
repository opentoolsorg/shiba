import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

test("check-dogfood-drift passes on aligned configs", () => {
  const result = spawnSync("node", ["scripts/check-dogfood-drift.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /aligned/);
});