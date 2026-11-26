import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { options } from "./deploy.mjs";
import { identities } from "./preview-guard.mjs";

for (const stage of ["prod", "live", "dogfood", "pr-1", "pr-277"]) {
  test(`single entry accepts stage ${stage}`, () => {
    assert.deepEqual(options([`--stage=${stage}`], {}), { stage: stage === "prod" ? "live" : stage, operation: "deploy" });
  });
}
for (const stage of ["production", "pr-0", "pr-01", "pr-277;rm", "", "test-123"]) {
  test(`entry rejects malformed or unreviewed stage ${stage}`, () => assert.throws(() => options([`--stage=${stage}`], {})));
}
test("prod aliases existing live state, while dogfood never aliases production", () => {
  assert.equal(options([], {}).stage, "live");
  assert.equal(options([], { ALCHEMY_STAGE: "dogfood" }).stage, "dogfood");
  assert.equal(options(["--plan"], {}).operation, "plan");
  assert.equal(options(["--destroy", "--stage=pr-277"], {}).operation, "destroy");
  assert.throws(() => options(["--destroy"], {}), /explicit stage/);
  assert.equal(options(["--dry-run"], {}).operation, "plan");
  assert.throws(() => options(["--typo"], {}), /Unknown/);
  assert.throws(() => options(["--stage=prod", "--stage=pr-1"], {}), /Conflicting/);
  assert.throws(() => options(["--stage=prod", "--destroy", "--plan"], {}), /Conflicting/);
});
test("Wrangler fallback cannot deploy previews or destroy any stage", () => {
  assert.throws(() => options(["--stage=pr-277", "--wrangler"], {}), /fallback/);
  assert.throws(() => options(["--stage=prod", "--wrangler", "--destroy"], {}), /fallback/);
  assert.equal(options(["--stage=dogfood", "--wrangler", "--plan"], {}).operation, "plan");
});
for (const script of ["ephemeral-stack.mjs", "preview-update-existing.mjs"]) {
  test(`${script} cannot execute its former deploy path`, () => {
    const result = spawnSync(process.execPath, [new URL(`./${script}`, import.meta.url).pathname, "--apply"], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /retired/);
  });
}
test("preview refuses missing remote state before any build or cloud request", () => {
  const result = spawnSync(process.execPath, [new URL("./deploy.mjs", import.meta.url).pathname, "--stage=pr-277", "--plan"], {
    encoding: "utf8", env: { ...process.env, ALCHEMY_STATE_BACKEND: "local" },
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /requires existing remote/);
});
test("all maintained deploy aliases enter the same guarded script", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  for (const key of ["deploy:alchemy", "deploy:preview", "deploy:preview:wrangler", "deploy:destroy"]) assert.match(scripts[key], /^node scripts\/deploy\.mjs/);
});
test("live drift check understands preview-only disabled email and cron", () => {
  const result = spawnSync(process.execPath, [new URL("./check-alchemy-drift.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.ok([0, 1].includes(result.status));
  assert.doesNotMatch(result.stderr, /check-alchemy-drift: crons:|Send Email/);
});
test("preview config applies migrations only in preview and disables cron with cap 1", () => {
  const source = readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
  assert.match(source, /isPreview \? \{ migrations: "\.\/apps\/backend\/migrations" \} : \{\}/);
  assert.match(source, /maxInstances: isPreview \? 1 : 10/);
  assert.match(source, /crons: isPreview \? \[\] :/);
});
test("real pinned Alchemy declarations and bindings pass the guard offline", { timeout: 30000 }, async (t) => {
  const source = `
    globalThis.fetch = () => { throw new Error("Network forbidden in declaration test"); };
    await import(new URL("./register-oxc.js", import.meta.resolve("alchemy/bin/alchemy.js")).href);
    const { Effect, Redacted } = await import("effect");
    const A = await import("alchemy/Alchemist"), Output = await import("alchemy/Output"), Resource = await import("alchemy/Resource");
    const { normalizePlanValue } = await import("./scripts/deploy.mjs");
    const { validatePlan } = await import("./scripts/preview-guard.mjs");
    const normalize = (v) => normalizePlanValue(v, { Effect, Redacted, Output, Resource });
    await Effect.runPromise(Effect.gen(function* () {
      const session = yield* A.open({ entrypoint: process.cwd() + "/alchemy.run.ts", stage: "pr-277" }, { adopt: false, updateStateStore: false });
      const resources = Object.values(session.stack.resources).map((r) => ({ fqn: r.FQN, type: r.Type, action: "create", props: normalize(r.Props), bindings: normalize(session.stack.bindings[r.FQN] ?? []) }));
      validatePlan({ stage: "pr-277", account: "a".repeat(32), head: "b".repeat(40), operation: "deploy", resources });
      console.log("validated " + resources.length + " real resource declarations");
      console.log("resource-types=" + JSON.stringify(resources.map((r) => r.type)));
    }).pipe(Effect.provide(A.layer()), Effect.scoped));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 25000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ALCHEMY_STAGE: "pr-277", ALCHEMY_STATE_BACKEND: "local",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), WORKERS_SUBDOMAIN: "preview", EXPECTED_HEAD: "b".repeat(40),
      BETTER_AUTH_SECRET: "preview-only-test-secret".repeat(2), BETTER_AUTH_OWNER_EMAIL: "preview@example.invalid", SLACK_BOT_TOKEN: "must-not-bind" },
  });
  assert.equal(result.status, 0, result.stderr);
  await t.test("CURRENT alchemy.run.ts resource types all have explicit guard handling", () => {
    const types = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith("resource-types=")).slice(15));
    assert.ok(types.length > 0);
    for (const type of types) assert.ok(Object.hasOwn(identities, type) || type === "Cloudflare.Queues.Consumer", `Unhandled resource type: ${type}`);
  });
  assert.match(result.stdout, /validated 18 real resource declarations/);
});
test("fork and checkout protections are present without pull_request_target", () => {
  const workflow = readFileSync(new URL("../.github/workflows/preview-deploy.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /pull_request\.head\.sha/);
  assert.match(workflow, /types: \[labeled, synchronize, reopened, closed\]/);
  assert.match(workflow, /PREVIEW_ACCOUNT_ID: \$\{\{ vars\.SHIBA_PREVIEW_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /secrets\.SLACK_|secrets\.CLAUDE_|number == 188/);
});
