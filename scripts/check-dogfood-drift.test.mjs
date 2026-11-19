import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { containerImageProblems, durableObjectProblems } from "./check-dogfood-drift.mjs";
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

test("pin-dogfood-image replaces the repository and digest of a full reference", () => {
  const source = readFileSync("apps/backend/wrangler.dogfood.jsonc", "utf8");
  const before = pinnedReference(source);
  assert.ok(before, "the dogfood config pins a managed-registry image");
  const [repository, digest] = before.split("@");
  const account = repository.split("/")[1];

  const otherRepository = `registry.cloudflare.com/${account}/shiba-ai-coworker-sandbox-dogfood`;
  const nextDigest = `sha256:${"a".repeat(64)}`;
  const moved = pinImage(source, `${otherRepository}@${nextDigest}`);
  assert.equal(pinnedReference(moved), `${otherRepository}@${nextDigest}`);
  assert.equal(moved, source.replace(before, `${otherRepository}@${nextDigest}`));

  const digestOnly = pinImage(source, nextDigest);
  assert.equal(pinnedReference(digestOnly), `${repository}@${nextDigest}`);

  assert.throws(() => pinImage(source, "latest"), /not a managed-registry image reference/);
  assert.throws(() => pinImage(source, "docker.io/library/node:22"), /not a managed-registry image reference/);
  assert.throws(() => pinImage("{}", nextDigest), /no managed-registry image pin/);
});

test("the dogfood config must use the declarative exports flow", () => {
  const bindings = [{ name: "Sandbox", class_name: "Sandbox" }];
  const containers = [{ name: "sandbox-app" }];
  const exportsBlock = { Sandbox: { type: "durable-object", storage: "sqlite", container: "sandbox-app" } };
  const base = { durable_objects: { bindings }, containers };

  assert.deepEqual(durableObjectProblems({ ...base, exports: exportsBlock }), []);

  assert.match(
    durableObjectProblems({ ...base, exports: exportsBlock, migrations: [{ tag: "v1" }] })[0],
    /refuses to revert to migrations \(100403\)/,
  );
  assert.match(durableObjectProblems(base)[0], /has no "exports" block/);
  assert.match(
    durableObjectProblems({ ...base, exports: { Other: { type: "durable-object", storage: "sqlite" } } }).join("\n"),
    /binds Durable Object class "Sandbox" with no live "exports" entry/,
  );
  assert.match(
    durableObjectProblems({
      ...base,
      exports: { ...exportsBlock, Extra: { type: "durable-object", storage: "sqlite" } },
    }).join("\n"),
    /exports Durable Object class "Extra" that no binding references/,
  );
  assert.match(
    durableObjectProblems({
      ...base,
      exports: { Sandbox: { type: "durable-object", storage: "sqlite", container: "missing-app" } },
    }).join("\n"),
    /is not a containers\[\] name/,
  );
});
