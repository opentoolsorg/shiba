import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const desktopWorkflow = readFileSync(new URL("../.github/workflows/desktop.yml", import.meta.url), "utf8");
const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"), workflow.indexOf("\nconcurrency:"));
const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
const jobBody = (id) => {
  const start = jobsBlock.indexOf(`\n  ${id}:\n`);
  const next = jobIds.map((j) => jobsBlock.indexOf(`\n  ${j}:\n`)).filter((i) => i > start).sort((a, b) => a - b)[0];
  return jobsBlock.slice(start, next ?? jobsBlock.length);
};

test("pull requests do not start validation merely because they opened", () => {
  const trigger = workflow.match(/pull_request:\n\s+types: \[([^\]]*)\]/)?.[1] ?? "";
  assert.doesNotMatch(trigger, /\bopened\b/);
  assert.match(trigger, /\bsynchronize\b/);
  assert.match(trigger, /\blabeled\b/);
  assert.match(trigger, /\bunlabeled\b/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
});

test("core lanes require build:validate on pull requests but still run on main", () => {
  for (const id of ["biome-knip", "check"]) {
    const body = jobBody(id);
    assert.match(body, /^ {4}if: .*\bpush\b.*build:validate/m, `${id} must be label-gated on pull requests`);
    assert.doesNotMatch(body, /verify:shiba/, `${id} must not require the browser-validation label`);
  }
});

test("expensive lanes stop early when a cheaper prerequisite fails", () => {
  assert.match(jobBody("check"), /^ {4}needs: biome-knip$/m);
  assert.match(jobBody("verify-shiba"), /^ {4}needs: check$/m);
});

test("verify-shiba is separately opt-in and ci:deferred is an explicit gate decision", () => {
  const verify = jobBody("verify-shiba");
  assert.match(verify, /^ {4}if: .*\bpush\b.*verify:shiba/m);
  assert.doesNotMatch(verify, /build:validate/);

  const gate = jobBody("all-checks-pass");
  assert.match(gate, /VERIFY_EXPECTED:.*verify:shiba/);
  assert.match(gate, /VERIFY_DEFERRED:.*ci:deferred/);
  assert.match(gate, /Add verify:shiba or ci:deferred/);
});

test("all-checks-pass needs every other job and runs unless the workflow was cancelled", () => {
  assert.ok(jobIds.includes("all-checks-pass"), "all-checks-pass job is missing");
  const body = jobBody("all-checks-pass");
  const needs = body.match(/needs: \[([^\]]*)\]/)?.[1].split(",").map((s) => s.trim()) ?? [];
  assert.deepEqual(needs.sort(), jobIds.filter((id) => id !== "all-checks-pass").sort());
  assert.match(body, /always\(\) && !cancelled\(\)/);
});

test("desktop and image lanes have separate cost opt-ins", () => {
  assert.match(desktopWorkflow, /desktop:validate/);
  assert.match(desktopWorkflow, /image:validate/);
  assert.doesNotMatch(desktopWorkflow, /build:validate/);
});
