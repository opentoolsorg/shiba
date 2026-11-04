import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET, DO_IDS, EXPECTED_BINDINGS, validateSnapshot, normalizeBindings, generatedConfig, assertConfig, wranglerArgs, inspectAssets, verifyHttpBuild } from "./preview-update-existing.mjs";

export function fixture() {
  const text = { OPEN_DASHBOARD: "0", WORKER_HOSTNAME: TARGET.hostname, BETTER_AUTH_URL: `https://${TARGET.hostname}`,
    ALCHEMY_STAGE: "pr-188", ALCHEMY_WORKER_NAME: TARGET.worker, ALCHEMY_CLOUDFLARE_ACCOUNT_ID: TARGET.accountId };
  return { accountId: TARGET.accountId, worker: TARGET.worker,
    deployment: { id: "current-deployment", versions: [{ version_id: TARGET.currentVersion, percentage: 100 }] },
    settings: { compatibility_date: "2026-06-01", compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
      observability: { enabled: true }, logpush: false, placement: {}, usage_model: "standard",
      bindings: Object.entries(EXPECTED_BINDINGS).map(([name, binding]) => ({ name, ...binding,
        ...(binding.type === "plain_text" ? { text: text[name] ?? "fixture" } : {}) })) },
    version: { id: TARGET.currentVersion, resources: { script: { last_deployed_from: "api" }, script_runtime: { assets: {} } } },
    historical: { id: TARGET.historicalVersion, resources: { script_runtime: { containers: [{ class_name: "Sandbox" }] } } },
    namespaces: Object.entries(DO_IDS).map(([name, id]) => ({ id, class: name, script: TARGET.worker, use_sqlite: true })),
    app: { id: TARGET.appId, name: TARGET.appName, account_id: TARGET.accountId, version: 1,
      durable_objects: { namespace_id: DO_IDS.Sandbox }, configuration: { image: TARGET.image } },
    routing: { proven: true, domains: [], routes: [], service: TARGET.worker, environment: "production" },
    schedules: [{ cron: "*/5 * * * *", created_on: "fixed" }],
  };
}

test("plans a metadata-only repair with exact existing resources, no app/image/credential creation", () => {
  const snapshot = fixture(), checked = validateSnapshot(snapshot);
  assert.equal(Object.keys(EXPECTED_BINDINGS).length, 47);
  assert.equal(checked.bindings.length, 47);
  assert.equal(checked.repair, true);
  assert.match(checked.plan.containerAction, /Reattach proven existing/);
  assert.match(checked.plan.scheduleAction, /Clear only/);
  assert.equal(checked.plan.resourceCreationPlanned, false);
  const config = generatedConfig(checked, "/reviewed-repository");
  assertConfig(config, "/reviewed-repository", checked);
  assert.deepEqual(config.containers, []);
  assert.equal(config.unsafe.bindings.length, 46);
  assert.equal(config.unsafe.bindings.some((binding) => binding.name === "ASSETS"), false);
  assert.deepEqual(config.unsafe.metadata.containers, [{ class_name: "Sandbox" }]);
  assert.deepEqual(config.unsafe.metadata.observability, snapshot.settings.observability);
});

for (const [name, change] of [
  ["production Worker", (s) => { s.worker = "shiba-ai-coworker"; }],
  ["wrong account", (s) => { s.accountId = "other-account"; }],
  ["stale version", (s) => { s.deployment.versions[0].version_id = "changed"; }],
  ["split deployment", (s) => { s.deployment.versions.push({ version_id: "other", percentage: 1 }); }],
  ["shared storage", (s) => { s.settings.bindings.find((b) => b.name === "ATTACHMENTS").bucket_name = "shiba-attachments"; }],
  ["foreign namespace", (s) => { s.namespaces[0].script = "production-worker"; }],
  ["unknown binding", (s) => { s.settings.bindings[0].name = "UNKNOWN"; }],
  ["secret binding", (s) => { s.settings.bindings[0] = { name: "TOKEN", type: "secret_text", text: "never-forward" }; }],
  ["public dashboard", (s) => { s.settings.bindings.find((b) => b.name === "OPEN_DASHBOARD").text = "1"; }],
  ["production hostname", (s) => { s.settings.bindings.find((b) => b.name === "WORKER_HOSTNAME").text = "app.tryshiba.dev"; }],
  ["missing historical proof", (s) => { delete s.historical; }],
  ["missing app", (s) => { delete s.app; }],
  ["changed app image", (s) => { s.app.configuration.image = "unreviewed-image"; }],
  ["changed app version", (s) => { s.app.version = 2; }],
  ["wrong app namespace", (s) => { s.app.durable_objects.namespace_id = "other"; }],
  ["ambiguous containers", (s) => { s.version.resources.script_runtime.containers = [{ class_name: "Other" }]; }],
  ["unknown cron", (s) => { s.schedules = [{ cron: "* * * * *" }]; }],
  ["unproven routes", (s) => { s.routing.proven = false; }],
  ["production route", (s) => { s.routing.routes = [{ pattern: "app.tryshiba.dev/*" }]; }],
  ["custom domain", (s) => { s.routing.domains = [{ hostname: "app.tryshiba.dev" }]; }],
  ["unknown API override", (s) => { s.version.resources.script.last_deployed_from = "dashboard"; }],
]) test(`rejects ${name} before planning any upload`, () => {
  const snapshot = fixture(); change(snapshot);
  assert.throws(() => validateSnapshot(snapshot));
});

for (const [name, change] of [
  ["migration", (c) => { c.migrations = [{ tag: "new", new_sqlite_classes: ["New"] }]; }],
  ["declarative namespace", (c) => { c.exports = { New: { type: "durable-object", storage: "sqlite" } }; }],
  ["container app/image", (c) => { c.containers = [{ class_name: "Sandbox", image: "Dockerfile" }]; }],
  ["production route", (c) => { c.routes = [{ pattern: "app.tryshiba.dev" }]; }],
  ["provisionable D1", (c) => { c.d1_databases = [{ binding: "NEW" }]; }],
  ["extra metadata", (c) => { c.unsafe.metadata.keep_bindings = ["secret_text"]; }],
  ["changed plain values", (c) => { c.unsafe.bindings.find((b) => b.name === "GATEWAY_ID").text = "different"; }],
  ["changed runtime metadata", (c) => { c.unsafe.metadata.observability.enabled = false; }],
  ["changed attachment class", (c) => { c.unsafe.metadata.containers[0].class_name = "Other"; }],
  ["wrong asset source", (c) => { c.assets.directory = "/private-data"; }],
]) test(`refuses generated config ${name}`, () => {
  const checked = validateSnapshot(fixture()), config = generatedConfig(checked, "/repo");
  change(config); assert.throws(() => assertConfig(config, "/repo", checked));
});

test("fingerprints current metadata and schedules, accepts already empty schedules and restored attachment", () => {
  const original = fixture(), before = validateSnapshot(original);
  const changed = structuredClone(original);
  changed.settings.bindings.find((b) => b.name === "GATEWAY_ID").text = "changed-after-build";
  assert.notEqual(validateSnapshot(changed).fingerprint, before.fingerprint);
  changed.schedules = [];
  changed.version.resources.script_runtime.containers = [{ class_name: "Sandbox" }];
  assert.equal(validateSnapshot(changed).repair, false);
});

test("uses pinned safe deploy flags with only the explicitly approved non-strict exception", () => {
  const args = wranglerArgs("/tmp/reviewed.json", "a".repeat(40), false);
  for (const flag of ["--no-x-provision", "--no-autoconfig", "--containers-rollout=none", "--keep-vars"]) assert(args.includes(flag));
  for (const forbidden of ["--strict", "--force", "--yes", "--secrets-file"]) assert.equal(args.includes(forbidden), false);
  assert.equal(args[args.indexOf("--tag") + 1], "a".repeat(40));
  assert(wranglerArgs("/tmp/reviewed.json", "a".repeat(40), true).includes("--dry-run"));
  assert.throws(() => wranglerArgs("/tmp/reviewed.json", "main", false));
});

test("checks built assets and rejects secret files and symlink escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-assets-test-"));
  try {
    await mkdir(join(dir, "app")); await writeFile(join(dir, "app/index.html"), "<html>New build</html>");
    assert.match(await inspectAssets(dir), /^[a-f0-9]{64}$/);
    await writeFile(join(dir, ".env"), "PRIVATE=never-upload");
    await assert.rejects(inspectAssets(dir), /Unsafe public asset/);
    await rm(join(dir, ".env")); await symlink("/outside", join(dir, "escape"));
    await assert.rejects(inspectAssets(dir), /symlinks/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("post-deploy HTTP proof requires locked API and exact built HTML/entrypoint bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-http-test-"));
  try {
    await mkdir(join(dir, "app")); await mkdir(join(dir, "assets"));
    const html = '<html><link href="/assets/app.css"/><script src="/assets/app.js"></script></html>';
    await writeFile(join(dir, "app/index.html"), html); await writeFile(join(dir, "assets/app.css"), "body{}"); await writeFile(join(dir, "assets/app.js"), "new build");
    const replies = new Map([["/api/runs", [401, "Unauthorized"]], ["/app/", [200, html]], ["/assets/app.css", [200, "body{}"]], ["/assets/app.js", [200, "new build"]]]);
    const fetcher = async (url, options) => {
      assert.equal(new URL(url).hostname, TARGET.hostname); assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, undefined);
      const [status, body] = replies.get(new URL(url).pathname);
      return new Response(body, { status });
    };
    assert.deepEqual(await verifyHttpBuild(dir, fetcher), { anonymousApiStatus: 401, dashboardHtmlVerified: true, staticEntrypointsVerified: 2 });
    replies.set("/api/runs", [200, "private output"]);
    await assert.rejects(verifyHttpBuild(dir, fetcher), /not locked/);
    replies.set("/api/runs", [401, "Unauthorized"]); replies.set("/assets/app.js", [200, "old build"]);
    await assert.rejects(verifyHttpBuild(dir, fetcher), /differs/);
    replies.set("/assets/app.js", [404, "Missing"]);
    await assert.rejects(verifyHttpBuild(dir, fetcher), /entrypoint failed/);
    await writeFile(join(dir, "app/index.html"), '<script src="/assets/../private.js"></script>');
    await assert.rejects(verifyHttpBuild(dir, fetcher), /unreviewed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("new workflow mode is fixed to PR188 and does not run Alchemy, comment or expose model/Slack credentials", async () => {
  const yaml = await readFile(new URL("../.github/workflows/preview-deploy.yml", import.meta.url), "utf8");
  const job = yaml.split("  update-existing-preview:")[1].split("  deploy-preview:")[0];
  assert.match(job, /preview:update-existing/); assert.match(job, /pull_request.number == 188/);
  assert.match(job, /opentoolsorg\/shiba/); assert.match(job, /persist-credentials: false/);
  assert.match(job, /pnpm build/); assert.match(job, /--preflight/); assert.match(job, /--apply/);
  assert.doesNotMatch(job, /run:.*alchemy|gh pr comment|secrets\.(?:SLACK|AI_GATEWAY|CLAUDE|CODEX|INTERNAL_SIGNING|ARTIFACT_SIGNING)/);
  assert.match(yaml.split("  deploy-preview:")[1], /label.name == 'preview:deploy'/);
  assert.equal(normalizeBindings(fixture().settings.bindings).length, 47);
});
