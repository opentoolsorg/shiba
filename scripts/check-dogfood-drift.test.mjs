import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { containerImageProblems } from "./check-dogfood-drift.mjs";
import { pinImage, pinnedReference } from "./pin-dogfood-image.mjs";
import { pinProblem } from "./check-dogfood-image-pin.mjs";

const DIGEST =
  "registry.cloudflare.com/73cf43cd7ec224111282832dc96b90e2/shiba-ai-coworker-sandbox-dogfood@sha256:494b5af5080a290a6bb2b092d9062d6974cb1fddb4a2b3e8abb27ee4c9fad360";

test("check-dogfood-drift passes on aligned configs", () => {
  const result = spawnSync("node", ["scripts/check-dogfood-drift.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /aligned/);
});

test("a digest-pinned managed image satisfies the container gate", () => {
  const problems = containerImageProblems({
    containers: [{ name: "sandbox", images: { sandbox: { image: DIGEST } } }],
  });
  assert.deepEqual(problems, []);
});

test("a Dockerfile build in the deployed config is rejected", () => {
  const problems = containerImageProblems({
    containers: [{ name: "sandbox", images: { sandbox: { dockerfile: "./Dockerfile" } } }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Workers Builds cannot push the sandbox image from the build/);
});

test("an unpinned or foreign image reference is rejected", () => {
  for (const image of [
    "registry.cloudflare.com/73cf43cd7ec224111282832dc96b90e2/shiba-sandbox:latest",
    "docker.io/library/node:22",
    DIGEST.replace("sha256:", "sha256:0"),
  ]) {
    const problems = containerImageProblems({
      containers: [{ name: "sandbox", images: { sandbox: { image } } }],
    });
    assert.equal(problems.length, 1, image);
    assert.match(problems[0], /must be a digest-pinned managed image/);
  }
});

test("pin-dogfood-image moves only the digest", () => {
  const source = readFileSync("apps/backend/wrangler.dogfood.jsonc", "utf8");
  const before = pinnedReference(source);
  assert.ok(before, "the dogfood config pins a managed-registry image");
  const [repository] = before.split("@");

  const nextDigest = `sha256:${"a".repeat(64)}`;
  const pinned = pinImage(source, nextDigest);
  assert.equal(pinnedReference(pinned), `${repository}@${nextDigest}`);
  assert.equal(pinned, source.replace(before, `${repository}@${nextDigest}`));

  assert.throws(() => pinImage(source, "latest"), /not a sha256 image digest/);
  assert.throws(() => pinImage("{}", nextDigest), /no managed-registry image pin/);
});

test("the pin guard requires a re-pin when the image inputs change", () => {
  const inputs = ["apps/backend/Dockerfile"];
  const digest = `registry.cloudflare.com/${"a".repeat(32)}/sandbox@sha256:${"b".repeat(64)}`;

  assert.equal(pinProblem({ changedInputs: [], head: digest, previous: "x" }), null);
  assert.equal(pinProblem({ changedInputs: inputs, head: "sha256:next", previous: "sha256:old" }), null);
  assert.match(pinProblem({ changedInputs: inputs, head: "sha256:old", previous: "sha256:old" }), /still references the old image/);
  assert.match(pinProblem({ changedInputs: inputs, head: null, previous: "sha256:old" }), /still references the old image/);
});
