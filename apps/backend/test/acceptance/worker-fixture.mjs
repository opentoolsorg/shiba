import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Actual Worker/React fixture: private local state, synthetic credentials, no remote bindings. */
export async function startWorkerFixture({ repoRoot = defaultRoot, buildAssets = true, localRuntime = false } = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "shiba-worker-fixture-"));
  const persistDir = path.join(tempRoot, "state");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const authSecret = `fixture-only-auth-${"a".repeat(48)}`;
  const adapterToken = `fixture-only-adapter-${"b".repeat(48)}`;
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(tempRoot, "home"), TMPDIR: tmpdir(), CI: "1",
    XDG_CONFIG_HOME: path.join(tempRoot, "config"), XDG_CACHE_HOME: path.join(tempRoot, "cache"),
    WRANGLER_LOG_PATH: path.join(tempRoot, "logs"), WRANGLER_SEND_METRICS: "false",
    ASTRO_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1",
  };
  const logs = [];
  const children = new Set();
  const collect = (chunk) => {
    logs.push(String(chunk).replaceAll(authSecret, "[fixture-auth]").replaceAll(adapterToken, "[fixture-adapter]").slice(-4096));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  };
  function launch(command, args) {
    const child = spawn(command, args, { cwd: repoRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", collect); child.once("close", () => children.delete(child));
    return child;
  }
  function signal(child, value) {
    if (!child.pid || child.pid <= 1 || child.pid === process.pid) return;
    try { process.kill(-child.pid, value); }
    catch (error) { if (error.code !== "ESRCH") throw new Error(`Fixture process termination unconfirmed (${error.code}).`); }
  }
  async function stopChild(child) {
    if (!children.has(child)) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    signal(child, "SIGTERM");
    let timer;
    const done = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 4000); })]);
    clearTimeout(timer);
    if (!done) {
      signal(child, "SIGKILL");
      let finalTimer;
      const killed = await Promise.race([closed.then(() => true), new Promise((resolve) => { finalTimer = setTimeout(() => resolve(false), 1000); })]);
      clearTimeout(finalTimer);
      if (!killed) throw new Error("Fixture process termination unconfirmed after SIGKILL.");
    }
  }
  async function stop() {
    await Promise.all([...children].map(stopChild));
    await rm(tempRoot, { recursive: true, force: true });
  }
  async function command(commandPath, args) {
    const child = launch(commandPath, args);
    let timer;
    try {
      const code = await Promise.race([
        new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture build/migration timed out.")), 120_000); }),
      ]);
      if (code !== 0) throw new Error(`Fixture build/migration exited ${code}.\n${logs.slice(-10).join("")}`);
    } finally { clearTimeout(timer); await stopChild(child); }
  }
  try {
    if (buildAssets) await command("pnpm", ["-C", "apps/frontend", "build"]);
    const assets = path.join(tempRoot, "assets");
    await cp(path.join(repoRoot, "apps/frontend/dist/client"), assets, { recursive: true, filter: (source) => path.basename(source) !== "_redirects" });
    const wranglerRequire = createRequire(await realpath(path.join(repoRoot, "node_modules/wrangler/package.json")));
    const { parse } = wranglerRequire("jsonc-parser");
    const errors = [];
    const backend = path.join(repoRoot, "apps/backend");
    const base = parse(await readFile(path.join(backend, "wrangler.jsonc"), "utf8"), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error("Fixture Wrangler configuration could not be parsed.");
    // Whitelist local storage; exclude production vars, secrets, remote bindings, cron, and Containers.
    const config = {
      name: "shiba-native-fixture", main: path.join(backend, base.main),
      compatibility_date: base.compatibility_date, compatibility_flags: base.compatibility_flags,
      assets: { ...base.assets, directory: assets }, durable_objects: base.durable_objects, migrations: base.migrations,
      d1_databases: base.d1_databases.map((database, index) => ({ binding: database.binding, database_name: `fixture-${index}`, database_id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`, migrations_dir: path.resolve(backend, database.migrations_dir) })),
      r2_buckets: base.r2_buckets.map((bucket, index) => ({ binding: bucket.binding, bucket_name: `fixture-bucket-${index}` })),
      kv_namespaces: base.kv_namespaces.map((namespace, index) => ({ binding: namespace.binding, id: (index + 1).toString(16).padStart(32, "0") })),
      vars: {
        BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: origin, BETTER_AUTH_OWNER_EMAIL: "native-owner@example.test",
        SHIBA_LOCAL_RUNTIME: localRuntime ? "1" : "0", LOCAL_ADAPTER_TOKEN: localRuntime ? adapterToken : "",
        RUNTIME: localRuntime ? "local" : "sandbox", WORKER_HOSTNAME: "", MCP_TRUSTED_HOSTS: "",
      },
    };
    const configPath = path.join(tempRoot, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const wrangler = path.join(repoRoot, "node_modules/wrangler/bin/wrangler.js");
    await command(process.execPath, [wrangler, "d1", "migrations", "apply", "fixture-0", "--local", `--config=${configPath}`, `--persist-to=${persistDir}`]);
    const worker = launch(process.execPath, [wrangler, "dev", "--local", `--config=${configPath}`, `--persist-to=${persistDir}`, `--port=${port}`, "--ip=127.0.0.1", "--inspector-port=0", "--enable-containers=false"]);
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Fixture Worker exited.\n${logs.slice(-15).join("")}`);
      try {
        const response = await fetch(`${origin}/api/auth/bootstrap`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return { origin, persistDir, tempRoot, logs, adapterToken, stop };
      } catch {}
      await delay(150);
    }
    throw new Error(`Fixture Worker startup timed out.\n${logs.slice(-15).join("")}`);
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture startup and cleanup failed."); }
    throw error;
  }
}
