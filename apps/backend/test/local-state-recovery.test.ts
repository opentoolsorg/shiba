import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../../scripts/local-state-recovery.mjs", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url));

// Actual Wrangler persistence, with no Shiba execution, cron, provider or remote binding.
const WORKER = `import { DurableObject } from 'cloudflare:workers';
export class RecordStore extends DurableObject {
  async fetch(request) {
    if (request.method === 'POST') await this.ctx.storage.put('value', await request.text());
    return Response.json(await this.ctx.storage.get('value') ?? null);
  }
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('ready');
  const record = env.RECORDS.get(env.RECORDS.idFromName('fixture'));
  if (url.pathname === '/seed' && request.method === 'POST') {
    const label = await request.text();
    await env.DB.exec('CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await env.DB.prepare('INSERT OR REPLACE INTO fixture (id,value) VALUES (1,?)').bind(label).run();
    await record.fetch('http://record/', {method:'POST', body:label});
    await env.BUCKET.put('receipt.bin', new TextEncoder().encode('SQLite format 3\\0' + label + '\\0' + 'blob-data'.repeat(2048)));
    return new Response('seeded');
  }
  if (url.pathname === '/read') {
    const row = await env.DB.prepare('SELECT value FROM fixture WHERE id=1').first();
    const durable = await (await record.fetch('http://record/')).json();
    const object = await env.BUCKET.get('receipt.bin');
    const bytes = await object.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return Response.json({d1:row.value, durable, r2:{size:bytes.byteLength,sha256}});
  }
  return new Response('missing',{status:404});
}};`;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

it("backs up, verifies, restores and rolls back actual stopped Wrangler DO/D1/R2 persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-local-recovery-"));
  const state = path.join(root, "source-state");
  const bundle = path.join(root, "bundle");
  const restored = path.join(root, "restored-state");
  const config = path.join(root, "wrangler.jsonc");
  const env = {
    PATH: process.env.PATH ?? "", TMPDIR: os.tmpdir(), HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    WRANGLER_LOG_PATH: path.join(root, "logs"), WRANGLER_SEND_METRICS: "false", CI: "1",
  };
  let worker: ChildProcess | undefined;
  let logs = "";
  const cli = (args: string[], preload?: string) => exec(process.execPath, [...(preload ? ["--import", preload] : []), SCRIPT, ...args], { env, timeout: 40_000 });
  async function stop() {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const child = worker;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wrangler did not stop cleanly")), 5000); })]);
    } catch (error) {
      child.kill("SIGKILL");
      await closed;
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function start(persist: string) {
    logs = "";
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    worker = spawn(process.execPath, [WRANGLER, "dev", "--local", `--config=${config}`, `--persist-to=${persist}`, `--port=${port}`, "--ip=127.0.0.1", "--inspector-port=0"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout?.on("data", (chunk) => { logs += String(chunk); });
    worker.stderr?.on("data", (chunk) => { logs += String(chunk); });
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Wrangler startup failed: ${logs}`);
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) return base;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Wrangler startup timed out: ${logs}`);
  }
  const expected = (label: string) => {
    const bytes = Buffer.from(`SQLite format 3\0${label}\0${"blob-data".repeat(2048)}`);
    return { d1: label, durable: label, r2: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  };
  try {
    await fs.writeFile(path.join(root, "worker.mjs"), WORKER);
    await fs.writeFile(config, JSON.stringify({
      // Installed workerd supports dates through 2026-09-30; use that binary without downloading another.
      name: "local-recovery-fixture", main: "worker.mjs", compatibility_date: "2026-09-30",
      durable_objects: { bindings: [{ name: "RECORDS", class_name: "RecordStore" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RecordStore"] }],
      d1_databases: [{ binding: "DB", database_name: "recovery-fixture", database_id: "00000000-0000-0000-0000-000000000001" }],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "recovery-fixture" }],
    }));

    let base = await start(state);
    expect((await fetch(`${base}/seed`, { method: "POST", body: "before" })).ok).toBe(true);
    expect(await (await fetch(`${base}/read`)).json()).toEqual(expected("before"));
    await expect(cli(["backup", state, bundle])).rejects.toThrow(/offline/);
    await expect(cli(["backup", "--offline", state, bundle])).rejects.toThrow(/files are open/);
    expect(existsSync(bundle)).toBe(false);
    await stop();

    await cli(["backup", "--offline", state, bundle]);
    const verified = JSON.parse((await cli(["verify", bundle])).stdout) as { counts: { files: number; sqliteDatabases: number; bytes: number } };
    expect(verified.counts.files).toBeGreaterThan(3);
    expect(verified.counts.sqliteDatabases).toBeGreaterThanOrEqual(3);
    expect(verified.counts.bytes).toBeGreaterThan(16000);
    expect((await fs.stat(bundle)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(bundle, "manifest.json"))).mode & 0o777).toBe(0o600);

    base = await start(state);
    expect((await fetch(`${base}/seed`, { method: "POST", body: "after" })).ok).toBe(true);
    expect(await (await fetch(`${base}/read`)).json()).toEqual(expected("after"));
    await stop();

    await cli(["restore", "--offline", bundle, restored]);
    await expect(cli(["restore", "--offline", bundle, restored])).rejects.toThrow(/already exists/);
    base = await start(restored);
    expect(await (await fetch(`${base}/read`)).json()).toEqual(expected("before"));
    await stop();
    // Roll back by selecting the preserved changed state, without copying over either state.
    base = await start(state);
    expect(await (await fetch(`${base}/read`)).json()).toEqual(expected("after"));
    await stop();

    const corrupt = path.join(root, "corrupt-bundle");
    await fs.cp(bundle, corrupt, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(corrupt, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    const first = manifest.files[0];
    if (!first) throw new Error("Fixture bundle was empty");
    await fs.appendFile(path.join(corrupt, "state", first.path), "corruption");
    const rejected = path.join(root, "rejected-restore");
    await expect(cli(["restore", "--offline", corrupt, rejected])).rejects.toThrow(/Integrity|SQLite/);
    expect(existsSync(rejected)).toBe(false);
    await fs.writeFile(path.join(corrupt, "manifest.json"), "fixture-secret-never-log");
    const malformed = await cli(["restore", "--offline", corrupt, rejected]).then(() => null, (error) => error as { stderr: string });
    expect(malformed?.stderr).toContain("Manifest JSON is invalid");
    expect(malformed?.stderr).not.toContain("fixture-secret-never-log");
    expect(existsSync(rejected)).toBe(false);

    const copied = path.join(root, "changed-during-copy");
    const preload = path.join(root, "change-copy.mjs");
    const sourceFile = path.join(state, first.path);
    await fs.writeFile(preload, `import fs from 'node:fs/promises'; const cp=fs.cp.bind(fs); fs.cp=async(...args)=>{await cp(...args);await fs.appendFile(${JSON.stringify(sourceFile)},'changed');};`);
    await expect(cli(["backup", "--offline", state, copied], preload)).rejects.toThrow(/Integrity|SQLite/);
    expect(existsSync(copied)).toBe(false);
  } finally {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
