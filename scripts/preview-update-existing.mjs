#!/usr/bin/env node
/** Legacy PR 188 incident-evidence helpers; uploads are retired.
 * --preflight delegates to the guarded full-stack plan, never apply.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGET = Object.freeze({
  accountId: "73cf43cd7ec224111282832dc96b90e2", worker: "shiba-ai-coworker-pr-188", pr: 188,
  hostname: "shiba-ai-coworker-pr-188.opentoolsorg.workers.dev", wrangler: "4.140.0",
  currentVersion: "101b11ea-f116-4504-8416-fd34db9d9586", historicalVersion: "4890183b-5ee4-4582-95b1-eb5848bfad24",
  appId: "a03cbf41-11e9-43a3-949a-fc0f80d377c0", appName: "shiba-ai-coworker-sandbox-pr-188", appVersion: 1,
  image: "registry.cloudflare.com/73cf43cd7ec224111282832dc96b90e2/shiba-ai-coworker-sandbox-pr-188@sha256:494b5af5080a290a6bb2b092d9062d6974cb1fddb4a2b3e8abb27ee4c9fad360",
});
export const DO_IDS = Object.freeze({
  Automations: "cf39dc78a49d4607bf03b7dc5e4d5c93", ChatGptAuth: "ddacbb92499744bf937853954a29c3d8",
  CodingOrchestrator: "0fd91e1b41fd4dc2ae8ecf418798551f", ConversationRoom: "648d63b7595f42618cc4f4310b3923da",
  LocalDispatch: "ce599c7769104f5ba3ba7e3b2be6bec1", Mailbox: "6be7157a75784828badb2d5fa1f9dfbb",
  Memory: "034a6d3a70a94b2ebf5949267f0cb06d", ModelConfig: "628ae998c3ce49b9afd57fd2f9a360dc",
  OpenCodeAgent: "c05415243f6743fd90adcea9f93ca80e", Sandbox: "a188af2739654906bb0a6adf23d918f7",
  Spaces: "38cd69b760f14ce9a6c9e703c853dfaf", UserProviderOAuth: "7c32ae8678b942b4be5bc439753315ea", Waitlist: "2de43d624d234553a33a0ab258134d6d",
});
const PLAINS = ["ALCHEMY_CLOUDFLARE_ACCOUNT_ID", "ALCHEMY_PHASE", "ALCHEMY_STACK_NAME", "ALCHEMY_STAGE", "ALCHEMY_WORKER_NAME",
  "BETTER_AUTH_URL", "CODING_MODEL", "GATEWAY_ID", "INSTANCE_TYPE", "INTEGRATIONS_PROVIDER", "MCP_TRUSTED_HOSTS", "OPEN_DASHBOARD",
  "ORCHESTRATOR_MODEL", "ROLE_MODEL_MAP", "RUNTIME", "SHIBA_ANTIGRAVITY_SUBSCRIPTION", "SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH",
  "SHIBA_CLAUDE_SUBSCRIPTION", "SHIBA_CODEX_DEVICE_AUTH", "SHIBA_CODEX_SUBSCRIPTION", "SHIBA_CURSOR_SUBSCRIPTION", "SLACK_CANVAS_OWNERS", "WORKER_HOSTNAME"];
export const EXPECTED_BINDINGS = Object.freeze({
  ...Object.fromEntries(PLAINS.map((name) => [name, { type: "plain_text" }])),
  ...Object.fromEntries(Object.entries(DO_IDS).map(([name, id]) => [name, { type: "durable_object_namespace", namespace_id: id, class_name: name }])),
  AGENT_AUDIT: { type: "d1", id: "47cb684c-6946-48aa-bc14-41bd62a1b41c" },
  AGENT_TOKENS: { type: "kv_namespace", namespace_id: "add0f67a86e8431caa60676b2fce1504" },
  ARTIFACTS: { type: "r2_bucket", bucket_name: "shiba-artifacts-pr-188" }, ATTACHMENTS: { type: "r2_bucket", bucket_name: "shiba-attachments-pr-188" },
  MEMORY_VECTORS: { type: "vectorize", index_name: "shiba-memory-pr-188" },
  MCP_RATE_LIMIT: { type: "ratelimit", namespace_id: "1001" }, AI: { type: "ai" }, ASSETS: { type: "assets" },
  BROWSER: { type: "browser" }, LOADER: { type: "worker_loader" }, SEND_EMAIL: { type: "send_email" },
});
const LINK = [{ class_name: "Sandbox" }];
const fail = (message) => { throw new Error(message); };
export const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a, b) => stable(a) === stable(b);
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function normalizeBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length !== 47) fail("Expected exactly the reviewed 47 preview bindings.");
  const seen = new Set();
  const rows = bindings.map((binding) => {
    const expected = EXPECTED_BINDINGS[binding.name];
    if (!expected || seen.has(binding.name) || binding.type !== expected.type) fail("Unknown, duplicate, or changed preview binding.");
    seen.add(binding.name);
    if (binding.type === "secret_text" || binding.type === "secret_key") fail("Secret round-trip is prohibited.");
    for (const [key, value] of Object.entries(expected)) if ((binding[key] ?? (key === "id" ? binding.database_id : undefined)) !== value) fail(`Unexpected resource for ${binding.name}.`);
    if (binding.script_name || binding.environment || binding.dispatch_namespace) fail("Cross-Worker Durable Object bindings are prohibited.");
    const allowed = {
      plain_text: ["text"], durable_object_namespace: ["namespace_id", "class_name"], d1: ["id", "database_id"],
      kv_namespace: ["namespace_id"], r2_bucket: ["bucket_name", "jurisdiction"], vectorize: ["index_name"],
      ratelimit: ["namespace_id", "simple"], ai: [], assets: [], browser: [], worker_loader: [], send_email: [],
    }[binding.type];
    if (!allowed || Object.keys(binding).some((key) => !["name", "type", ...allowed].includes(key))) fail(`Unreviewed binding fields for ${binding.name}.`);
    if (binding.type === "plain_text" && typeof binding.text !== "string") fail("Invalid plain variable.");
    const row = { ...binding };
    if (row.type === "d1") { row.id ??= row.database_id; delete row.database_id; }
    return row;
  }).sort((a, b) => a.name.localeCompare(b.name));
  const value = (name) => rows.find((row) => row.name === name)?.text;
  if (value("OPEN_DASHBOARD") !== "0" || value("WORKER_HOSTNAME") !== TARGET.hostname || value("BETTER_AUTH_URL") !== `https://${TARGET.hostname}`)
    fail("Preview authentication or hostname drifted; public/production configuration is forbidden.");
  if (value("ALCHEMY_STAGE") !== "pr-188" || value("ALCHEMY_WORKER_NAME") !== TARGET.worker || value("ALCHEMY_CLOUDFLARE_ACCOUNT_ID") !== TARGET.accountId)
    fail("Preview stage/account metadata does not match the fixed target.");
  return rows;
}

export function normalizeApp(app) {
  if (!app || app.id !== TARGET.appId || app.name !== TARGET.appName || app.account_id !== TARGET.accountId || app.version !== TARGET.appVersion ||
      app.durable_objects?.namespace_id !== DO_IDS.Sandbox || app.configuration?.image !== TARGET.image)
    fail("Existing Sandbox app, version, image, or namespace does not match the reviewed attachment.");
  return { id: app.id, name: app.name, accountId: app.account_id, version: app.version, namespaceId: app.durable_objects.namespace_id, image: app.configuration.image };
}

export function validateSnapshot(snapshot, expectedVersion = TARGET.currentVersion) {
  if (snapshot.accountId !== TARGET.accountId || snapshot.worker !== TARGET.worker) fail("Only the fixed PR 188 account and Worker may be updated.");
  if (!snapshot.deployment?.id || snapshot.deployment.versions?.length !== 1 || snapshot.deployment.versions[0].percentage !== 100 ||
      snapshot.deployment.versions[0].version_id !== expectedVersion || snapshot.version?.id !== expectedVersion)
    fail("Active preview version changed or traffic is split; no upload permitted.");
  const bindings = normalizeBindings(snapshot.settings?.bindings);
  if (snapshot.routing?.proven !== true || snapshot.routing.service !== TARGET.worker || snapshot.routing.environment !== "production" ||
      !Array.isArray(snapshot.routing.domains) || snapshot.routing.domains.length || !Array.isArray(snapshot.routing.routes) || snapshot.routing.routes.length)
    fail("No-production-route/domain proof is missing or an unexpected route is attached.");
  if (!Array.isArray(snapshot.schedules) || snapshot.schedules.length > 1 ||
      (snapshot.schedules.length === 1 && snapshot.schedules[0]?.cron !== "*/5 * * * *"))
    fail("Only the explicitly authorized preview cron or an already empty schedule is allowed.");
  if (expectedVersion === TARGET.currentVersion && snapshot.version.resources?.script?.last_deployed_from !== "api")
    fail("The intentional non-strict exception applies only to the reviewed API-owned mitigation version.");
  if (snapshot.settings.compatibility_date !== "2026-06-01" || !equal([...(snapshot.settings.compatibility_flags ?? [])].sort(), ["legacy_module_registry", "nodejs_compat"]))
    fail("Unexpected compatibility configuration.");
  for (const [name, id] of Object.entries(DO_IDS)) {
    const namespace = snapshot.namespaces?.find((row) => row.id === id);
    if (!namespace || namespace.script !== TARGET.worker || namespace.class !== name || namespace.use_sqlite !== true)
      fail(`Preview namespace ownership is unproven for ${name}.`);
  }
  if (snapshot.historical?.id !== TARGET.historicalVersion || !equal(snapshot.historical.resources?.script_runtime?.containers, LINK))
    fail("Historical Sandbox attachment proof is missing or changed.");
  const currentContainers = snapshot.version.resources?.script_runtime?.containers;
  if (currentContainers !== undefined && !equal(currentContainers, LINK)) fail("Ambiguous or unreviewed current container metadata.");
  const app = normalizeApp(snapshot.app);
  const repair = currentContainers === undefined;
  if (snapshot.settings.usage_model !== undefined && snapshot.settings.usage_model !== "standard") fail("Unexpected preview usage model.");
  const runtimeMetadata = Object.fromEntries(["observability", "logpush", "placement", "limits", "usage_model"]
    .filter((key) => snapshot.settings[key] !== undefined).map((key) => [key, snapshot.settings[key]]));
  return { bindings, app, repair, runtimeMetadata, versionId: expectedVersion, deploymentId: snapshot.deployment.id,
    fingerprint: sha(stable({ deployment: snapshot.deployment.id, version: expectedVersion, bindings, app,
      runtime: snapshot.version.resources?.script_runtime, settings: snapshot.settings, routing: snapshot.routing, schedules: snapshot.schedules })),
    plan: { accountId: TARGET.accountId, worker: TARGET.worker, bindingCount: bindings.length, namespaceCount: 13,
      containerAction: repair ? "Reattach proven existing Sandbox metadata; no app/image mutation" : "Preserve proven existing Sandbox metadata",
      scheduleAction: snapshot.schedules.length ? "Clear only the known preview */5 cron to prevent background execution" : "Preserve empty preview schedules",
      providerExecutionVerified: false, credentialCreationPlanned: false, resourceCreationPlanned: false } };
}

export function generatedConfig(validated, repositoryRoot) {
  return { name: TARGET.worker, account_id: TARGET.accountId, main: join(repositoryRoot, "apps/backend/src/index.ts"),
    compatibility_date: "2026-06-01", compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
    workers_dev: true, preview_urls: false, routes: [], triggers: { crons: [] }, keep_vars: true,
    assets: { directory: join(repositoryRoot, "app-public"), binding: "ASSETS", not_found_handling: "404-page", run_worker_first: false },
    // Empty, not a Container application declaration. Forces the legacy upload
    // path which supports existing Container metadata in pinned Wrangler.
    containers: [],
    // Keep the reviewed snapshot independent of the emitted, mutable config.
    unsafe: { bindings: structuredClone(validated.bindings.filter((row) => row.type !== "assets")),
      metadata: structuredClone({ ...validated.runtimeMetadata, containers: LINK }) },
  };
}

export function assertConfig(config, repositoryRoot, validated) {
  const allowed = ["name", "account_id", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "triggers", "keep_vars", "assets", "containers", "unsafe"];
  if (config.name !== TARGET.worker || config.account_id !== TARGET.accountId || config.migrations || config.exports ||
      Object.keys(config).some((key) => !allowed.includes(key)) || !Array.isArray(config.containers) || config.containers.length ||
      !equal(config.routes, []) || !equal(config.triggers, { crons: [] }) || config.workers_dev !== true || config.preview_urls !== false || config.keep_vars !== true ||
      config.main !== join(repositoryRoot, "apps/backend/src/index.ts") || config.compatibility_date !== "2026-06-01" ||
      !equal(config.compatibility_flags, ["nodejs_compat", "legacy_module_registry"]) ||
      !equal(config.assets, { directory: join(repositoryRoot, "app-public"), binding: "ASSETS", not_found_handling: "404-page", run_worker_first: false }) ||
      Object.keys(config.unsafe ?? {}).some((key) => !["bindings", "metadata"].includes(key)) ||
      !validated || !equal(config.unsafe?.metadata, { ...validated.runtimeMetadata, containers: LINK })) fail("Provisioning, migrations, production routes, or unreviewed metadata are prohibited.");
  const bindings = normalizeBindings([...(config.unsafe?.bindings ?? []), { name: "ASSETS", type: "assets" }]);
  if (!equal(bindings, validated.bindings)) fail("Generated binding values differ from the reviewed snapshot.");
}

export function wranglerArgs(configPath, head, dryRun) {
  if (!/^[a-f0-9]{40}$/.test(head)) fail("An exact Git head is required.");
  return ["exec", "wrangler", "deploy", "--config", configPath, "--no-x-provision", "--no-autoconfig", "--containers-rollout=none",
    // Root explicitly approved this fixed API-owned version override. Pinned
    // Wrangler confirms true in CI without strict; no --yes/--force exists here.
    "--keep-vars", "--tag", head, "--message", `PR 188 existing-resource update ${head}`, ...(dryRun ? ["--dry-run"] : [])];
}

export async function inspectAssets(directory) {
  const manifest = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name), stat = await lstat(full);
      if (stat.isSymbolicLink()) fail("Asset symlinks are prohibited.");
      if (stat.isDirectory()) { await visit(full); continue; }
      if (!stat.isFile() || /^(?:\.env(?:\..*)?|\.dev\.vars.*|wrangler\..*|_worker\.js)$/.test(entry.name) || /\.(?:pem|key)$/i.test(entry.name)) fail("Unsafe public asset file.");
      manifest.push([full.slice(directory.length + 1), stat.size, sha(await readFile(full))]);
      if (manifest.length > 20_000) fail("Asset manifest is too large.");
    }
  };
  await visit(directory);
  if (!manifest.some(([name]) => name === "app/index.html") || manifest.reduce((n, row) => n + row[1], 0) > 128 * 1024 * 1024) fail("Missing dashboard build or excessive assets.");
  return sha(stable(manifest.sort(([a], [b]) => a.localeCompare(b))));
}

export const verifyHttpBuild = (directory, fetcher = fetch) => verifyHttpBuildAt(directory, `https://${TARGET.hostname}`, fetcher);
export async function verifyHttpBuildAt(directory, origin, fetcher = fetch) {
  if (!/^https:\/\/shiba-ai-coworker-pr-[1-9]\d*\.[a-z0-9-]+\.workers\.dev$/.test(origin)) fail("Only a preview workers.dev origin may be probed");
  const get = (path) => fetcher(`${origin}${path}`, { redirect: "error", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  // Probe an unmatched protected path. Reading retained runs can wake work if
  // authentication is misconfigured, which is precisely what this checks.
  const privateApi = await get("/api/__shiba_preview_auth_probe__");
  if (privateApi.status !== 401) fail("Anonymous preview API is not locked; stop and inspect authentication.");
  const index = await readFile(join(directory, "app/index.html"));
  const entries = [...new Set([...index.toString("utf8").matchAll(/(?:src|href)=["'](\/[^"']+\.(?:js|css))["']/g)].map((match) => match[1]))];
  if (!entries.length || entries.length > 20 || entries.some((path) => !/^\/assets\/[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(path) || path.includes("..")))
    fail("Dashboard entrypoint manifest is missing or unreviewed.");
  for (const [urlPath, filePath, expected] of [["/app/", "app/index.html", index], ...entries.map((path) => [path, path.slice(1)])]) {
    const body = expected ?? await readFile(join(directory, filePath));
    if (body.length > 16 * 1024 * 1024) fail("Static entrypoint exceeds the verification bound.");
    const response = await get(urlPath);
    if (response.status !== 200) fail(`Preview static entrypoint failed (${response.status}): ${urlPath}`);
    const reader = response.body?.getReader();
    if (!reader) fail("Preview static entrypoint returned no body.");
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > body.length) fail(`Preview static entrypoint differs from the reviewed build: ${urlPath}`);
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    if (size !== body.length || sha(Buffer.concat(chunks)) !== sha(body)) fail(`Preview static entrypoint differs from the reviewed build: ${urlPath}`);
  }
  return { anonymousApiStatus: 401, dashboardHtmlVerified: true, staticEntrypointsVerified: entries.length };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes("--preflight")) fail("Code-only updater retired; use scripts/deploy.mjs with an explicit stage after reviewing its full-stack plan.");
  const { main: deploy } = await import("./deploy.mjs");
  return deploy(["--stage=pr-188", "--plan"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
