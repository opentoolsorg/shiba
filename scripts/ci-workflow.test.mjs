import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"), workflow.indexOf("\nconcurrency:"));
const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
const jobBody = (id) => {
  const start = jobsBlock.indexOf(`\n  ${id}:\n`);
  const next = jobIds.map((j) => jobsBlock.indexOf(`\n  ${j}:\n`)).filter((i) => i > start).sort((a, b) => a - b)[0];
  return jobsBlock.slice(start, next ?? jobsBlock.length);
};

test("CI runs on every pull request push and on main", () => {
  assert.match(workflow, /pull_request:\n\s+types: \[[^\]]*\bsynchronize\b[^\]]*\]/);
  assert.match(workflow, /pull_request:\n\s+types: \[[^\]]*\bopened\b[^\]]*\]/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
});

test("all-checks-pass needs every other job and runs unless the workflow was cancelled", () => {
  assert.ok(jobIds.includes("all-checks-pass"), "all-checks-pass job is missing");
  const body = jobBody("all-checks-pass");
  const needs = body.match(/needs: \[([^\]]*)\]/)?.[1].split(",").map((s) => s.trim()) ?? [];
  assert.deepEqual(needs.sort(), jobIds.filter((id) => id !== "all-checks-pass").sort());
  assert.match(body, /if: \$\{\{ !cancelled\(\) \}\}/);
});

test("the lint and check lanes are never skipped", () => {
  for (const id of ["biome-knip", "check"]) assert.doesNotMatch(jobBody(id), /^ {4}if:/m, `${id} must run on every event`);
});
