#!/usr/bin/env node
/**
 * Clean local install smoke: build static assets, apply local D1 migrations,
 * start Wrangler without Containers, and verify the dashboard/API. Uses an
 * isolated temp persistence directory and never calls a model or writes to a
 * third-party service.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "apps/backend/wrangler.jsonc";
const WRANGLER = resolve(ROOT, "node_modules/.bin/wrangler");
const stateDir = mkdtempSync(resolve(tmpdir(), "shiba-selfhost-smoke-"));
const persistDir = resolve(stateDir, "persist");
const configDir = resolve(stateDir, "config");
const cacheDir = resolve(stateDir, "cache");
const logs = [];
let worker;

function smokeEnv() {
  const allowed = ["PATH", "NODE_OPTIONS", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "COMSPEC", "PATHEXT"];
  const safe = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return {
    ...safe,
    CI: "1",
    COREPACK_HOME: resolve(tmpdir(), "shiba-corepack"),
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: cacheDir,
    WRANGLER_SEND_METRICS: "false",
    ASTRO_TELEMETRY_DISABLED: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    // Turbo's strict environment mode otherwise filters these local-only
    // settings from its child build processes. This process environment is
    // allowlisted above, so loose mode does not pass operator credentials.
    TURBO_ENV_MODE: "loose",
  };
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    env: smokeEnv(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
  return address.port;
}

async function waitForWorker(url) {
  const deadline = Date.now() + 45_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited ${worker.exitCode}:\n${logs.join("")}`);
    try {
      const response = await fetch(`${url}/api/setup/wizard`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`wizard route returned HTTP ${response.status}`);
      const body = await response.json();
      if (body.ok !== true) throw new Error("wizard route returned an unexpected response");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    }
  }
  throw new Error(`Wrangler did not become ready: ${lastError}\n${logs.join("")}`);
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => worker.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (worker.exitCode === null) worker.kill("SIGKILL");
}

try {
  console.log("[selfhost] building dashboard and docs (no deploy)");
  run("corepack", ["pnpm", "build"], "corepack pnpm build");

  console.log("[selfhost] applying D1 migrations to isolated local storage");
  run(
    WRANGLER,
    ["d1", "migrations", "apply", "shiba-audit", "--local", `--config=${CONFIG}`, `--persist-to=${persistDir}`],
    "local D1 migrations",
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`[selfhost] starting local Worker at ${base} (Containers disabled)`);
  worker = spawn(
    WRANGLER,
    ["dev", "--local", `--config=${CONFIG}`, `--port=${port}`, `--persist-to=${persistDir}`, "--enable-containers=false", "--local-upstream", "localhost"],
    {
      cwd: ROOT,
      env: smokeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  worker.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  await waitForWorker(base);

  const app = await fetch(`${base}/app/`, { signal: AbortSignal.timeout(5_000) });
  if (!app.ok) throw new Error(`dashboard route returned HTTP ${app.status}`);
  const html = await app.text();
  if (!html.includes("<html") || !html.includes("/app/")) {
    throw new Error("dashboard route did not return the built app shell");
  }

  const schema = spawnSync(
    WRANGLER,
    [
      "d1",
      "execute",
      "shiba-audit",
      "--local",
      `--config=${CONFIG}`,
      `--persist-to=${persistDir}`,
      "--command",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('skills', 'skill_versions') ORDER BY name;",
    ],
    {
      cwd: ROOT,
      env: smokeEnv(),
      encoding: "utf8",
    },
  );
  const schemaOutput = `${schema.stdout ?? ""}\n${schema.stderr ?? ""}`;
  if (schema.error || schema.status !== 0 || !schemaOutput.includes("skills") || !schemaOutput.includes("skill_versions")) {
    throw new Error(`local migration verification failed:\n${schemaOutput}`);
  }

  console.log("[selfhost] PASS: local migrations applied; /api/setup/wizard returned JSON; /app/ returned built HTML");
  console.log("[selfhost] This checks local boot only; it does not test model inference, OAuth providers, Cloudflare services, or deployment.");
} catch (error) {
  console.error(`[selfhost] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await stopWorker();
  rmSync(stateDir, { recursive: true, force: true });
}
