import { createRequire, builtinModules } from "node:module";
import { mkdtemp, readFile, writeFile, rm, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const bounded = async (work, milliseconds, label) => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
export async function waitFor(read, accept, milliseconds = 10_000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { const value = await read(); if (accept(value)) return value; await delay(15); }
  throw new Error("Local recovery fixture barrier timed out");
}
export async function startJournalWorkerFixture({ purpose = "same-container" } = {}) {
  if (!["same-container", "replacement-archive"].includes(purpose)) throw new Error("Unknown fixed local journal fixture purpose");
  const root = await mkdtemp(path.join(tmpdir(), "shiba-worker-journal-"));
  const bundle = path.join(root, "worker.mjs"), sourceBundle = path.join(root, "journal.mjs"), adapterBundle = path.join(root, "adapter.mjs");
  let runtime, origin, supervisor;
  const sockets = new Set(), processes = new Set(), workerProcesses = new Map(), logs = [], deniedNetwork = [];
  const jobId = createHash("sha256").update(root).digest("hex"), persist = path.join(root, "state");
  let startCount = 0, input, digest, localSource, adapter;
  const trace = { root, workerStarts: 0, deniedNetwork, logs };
  const output = (data) => { logs.push(String(data).slice(-1000)); if (logs.length > 40) logs.shift(); };
  async function processIdentity(pid) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0");
      const binary = path.basename(args[0]);
      const parent = Number(fields[1]);
      // Inspect no unrelated process environment, even when it is another workerd.
      const tagged = parent === process.pid && binary === "workerd" && (await readFile(`/proc/${pid}/environ`)).toString().split("\0").includes(`SHIBA_LOCAL_RECOVERY_FIXTURE_ID=${jobId}`);
      return { state: fields[0], parent, group: Number(fields[2]), session: Number(fields[3]), start: fields[19], binary, tagged };
    } catch { return null; }
  }
  async function trackWorkers() {
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      const identity = await processIdentity(pid);
      if (identity?.parent === process.pid && identity.binary === "workerd" && identity.tagged) workerProcesses.set(Number(pid), identity.start);
    }
  }
  async function killOwnedWorkers() {
    for (const [pid, start] of workerProcesses) {
      const current = await processIdentity(pid);
      if (!current || current.start !== start || current.binary !== "workerd" || !current.tagged) continue;
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await delay(50);
    for (const [pid, start] of workerProcesses) {
      const current = await processIdentity(pid);
      if (!current || current.start !== start || current.binary !== "workerd" || !current.tagged) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  async function disposeRuntime() {
    if (!runtime) return;
    const owned = runtime; runtime = undefined;
    try { await bounded(owned.dispose(), 10_000, "Owned workerd shutdown"); }
    finally { await killOwnedWorkers(); }
  }
  async function stopSource() {
    if (!supervisor) return;
    let anchor;
    try {
      const meta = JSON.parse(await readFile(path.join(root, "journals", jobId, "meta.json"), "utf8"));
      if (meta.jobId === jobId && meta.digest === digest && meta.supervisorPid === supervisor.pid && Number.isSafeInteger(meta.childPid) && typeof meta.childStart === "string") {
        anchor = { pid: meta.childPid, start: meta.childStart };
      }
    } catch { /* Setup may have failed before publishing the fixture-owned metadata. */ }
    const currentAnchor = async () => {
      if (!anchor) return null;
      const current = await processIdentity(anchor.pid);
      return current?.start === anchor.start && current.group === anchor.pid && current.session === anchor.pid && current.state !== "Z" ? current : null;
    };
    if (supervisor.exitCode === null && supervisor.signalCode === null && localSource && input) {
      await exec(process.execPath, ["-e", localSource, "--", "cancel", jobId, "0", digest, String(input.deadline)], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 4_000, maxBuffer: 500_000,
      }).catch(() => {});
      // Cancellation writes a marker. Leave the supervisor alive to observe it and
      // terminate its detached anchor; killing the supervisor first orphans it.
      await waitFor(async () => ({ anchor: await currentAnchor(), supervisorAlive: supervisor.exitCode === null && supervisor.signalCode === null }),
        (value) => !value.anchor && !value.supervisorAlive, 2_500).catch(() => {});
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (await currentAnchor()) {
        try { process.kill(-anchor.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (signal === "SIGTERM") await delay(100);
    }
    await waitFor(currentAnchor, (value) => !value, 1_000);
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await delay(50);
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  try {
    const require = createRequire(await realpath(path.join(repoRoot, "node_modules/wrangler/package.json")));
    const { build } = require("esbuild"), { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require("miniflare");
    const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
    await build({ entryPoints: [path.join(repoRoot, `apps/backend/test/acceptance/${purpose === "replacement-archive" ? "worker-archive-replacement-entry" : "worker-journal-fixture-entry"}.ts`)], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"], logLevel: "silent",
      plugins: [{ name: "workerd-node-compat", setup(build) { build.onResolve({ filter: /^(?:node:)?[a-z_]+(?:\/[a-z_]+)?$/ }, (args) => {
        const name = args.path.replace(/^node:/, ""); return builtins.has(name) ? { path: `node:${name}`, external: true } : undefined;
      }); } }],
    });
    await build({ entryPoints: [path.join(repoRoot, "apps/backend/src/sandbox/execution-journal.ts")], outfile: sourceBundle, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    await build({ entryPoints: [path.join(repoRoot, "packages/sandbox/src/adapters/cloudflare-journal.ts")], outfile: adapterBundle, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    const { EXECUTION_JOURNAL_SOURCE, executionInputDigest } = await import(pathToFileURL(sourceBundle));
    adapter = await import(pathToFileURL(adapterBundle));
    const literal = 'const ROOT = "/var/lib/shiba-executions";';
    if (!EXECUTION_JOURNAL_SOURCE.includes(literal)) throw new Error("Production journal root literal changed");
    localSource = EXECUTION_JOURNAL_SOURCE.replace(literal, `const ROOT = ${JSON.stringify(path.join(root, "journals"))};`);
    const gate1 = path.join(root, "continue-1"), gate2 = path.join(root, "continue-2"), phase1 = path.join(root, "phase-1"), phase2 = path.join(root, "phase-2"), launched = path.join(root, "launches");
    const program = purpose === "replacement-archive"
      ? `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(launched)},'launch\\n');const pause=()=>new Promise(r=>setTimeout(r,15));const wait=p=>new Promise(r=>{const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);r()}},10)});(async()=>{process.stdout.write('prefix\\n');process.stderr.write('stderr-prefix\\n');fs.writeFileSync(${JSON.stringify(phase1)},'1');await wait(${JSON.stringify(gate1)});for(let i=0;i<36;i++){process.stdout.write('page-line-'+i+'-'+('x'.repeat(3990))+'\\n');await pause()}process.stdout.write('fixture-secret-');await pause();process.stdout.write('value\\n');process.stdout.write(Buffer.from([0xf0,0x9f]));await pause();process.stdout.write(Buffer.from([0x99,0x82,0x0a]));fs.writeFileSync(${JSON.stringify(phase2)},'2');await wait(${JSON.stringify(gate2)});process.stdout.write('unacknowledged-tail\\n');setInterval(()=>{},1000)})()`
      : `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(launched)},'launch\\n');const wait=p=>new Promise(r=>{const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);r()}},10)});(async()=>{process.stdout.write('before\\n');process.stderr.write('stderr-before\\n');process.stdout.write('fixture-secret-');fs.writeFileSync(${JSON.stringify(phase1)},'1');await wait(${JSON.stringify(gate1)});process.stdout.write('value\\n');process.stdout.write(Buffer.from([0xf0,0x9f]));fs.writeFileSync(${JSON.stringify(phase2)},'2');await wait(${JSON.stringify(gate2)});process.stdout.write(Buffer.from([0x99,0x82,0x0a]));process.stderr.write('stderr-after\\n');process.stdout.write('after\\n')})()`;
    input = { jobId, command: `${quote(process.execPath)} -e ${quote(program)}`, cwd: root, deadline: Date.now() + 90_000, env: {} };
    digest = await executionInputDigest(input);
    async function restart() {
      for (const socket of sockets) socket.close(); sockets.clear();
      await disposeRuntime();
      runtime = new Miniflare(convertV4MiniflareOptions({ name: `journal-recovery-${jobId.slice(0, 12)}`, rootPath: root, modulesRoot: root, scriptPath: bundle, modules: true,
        compatibilityDate: "2026-09-18", compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 0, inspectorPort: 0,
        cf: false, telemetry: { enabled: false }, unsafeRuntimeEnv: { SHIBA_LOCAL_RECOVERY_FIXTURE_ID: jobId }, logRequests: false, log: new Log(LogLevel.ERROR, { prefix: "journal-fixture" }),
        resourcePersistencePath: persist, isolatedResourcePersistencePath: path.join(root, "isolated"), resourceTmpPath: path.join(root, "tmp"), unsafeDevRegistryPath: path.join(root, "dev-registry"), bindings: { FIXTURE_JOB: jobId,
          ...(purpose === "replacement-archive" ? { INTERNAL_SIGNING_KEY: "local-fixture-archive-key-only-1234567890" } : {}) },
        durableObjects: { ConversationRoom: { className: "ConversationRoom", useSQLite: true }, ...(purpose === "replacement-archive" ? { Sandbox: { className: "ArchiveFixtureSource", useSQLite: true } } : {}) },
        ...(purpose === "replacement-archive" ? { d1Databases: { AGENT_AUDIT: "local-archive-d1" } } : {}),
        outboundService: async (request) => { deniedNetwork.push(new URL(request.url).origin); return new Response("Fixture outbound network denied", { status: 502 }); },
        handleUncaughtError: (error) => output(error.message),
      }));
      try { origin = (await bounded(runtime.ready, 15_000, "Owned workerd startup")).origin; }
      finally { await trackWorkers(); }
      if (![...workerProcesses.keys()].some((pid) => pid > 1)) throw new Error("Owned workerd process marker was not established");
      trace.workerStarts++; return origin;
    }
    async function start() {
      if (startCount++) throw new Error("Fixture source START may run only once");
      supervisor = spawn(process.execPath, ["-e", localSource, "--", "start", jobId], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "pipe"] });
      processes.add(supervisor); supervisor.stderr.on("data", output); supervisor.on("error", output);
      supervisor.stdin.end(JSON.stringify({ ...input, digest }));
      await waitFor(() => readFile(phase1).then(() => true, () => false), Boolean);
    }
    async function control(action, after = 0) {
      const result = await exec(process.execPath, ["-e", localSource, "--", action, jobId, String(after), digest, String(input.deadline)], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 4_000, maxBuffer: 500_000,
      });
      return JSON.parse(result.stdout);
    }
    async function read() { return control("read"); }
    async function api(route, body) {
      const response = await fetch(`${origin}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new Error(`Fixture ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
    }
    async function socket(retention = false) {
      const client = new WebSocket(`${origin.replace("http:", "ws:")}/socket${retention ? "?retention=1" : ""}`);
      sockets.add(client); const frames = [];
      client.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
      await bounded(new Promise((resolve, reject) => { client.addEventListener("open", resolve, { once: true }); client.addEventListener("error", () => reject(new Error("Local TCP WebSocket failed")), { once: true }); }), 10_000, "TCP WebSocket open");
      await waitFor(() => frames, (items) => items.some((frame) => frame.type === "snapshot"));
      return { client, frames, async replay(after) { const from = frames.length; client.send(JSON.stringify({ type: "subscribe", after })); return waitFor(() => frames.slice(from), (items) => items.some((frame) => frame.type === "run:replay_complete")); } };
    }
    async function stop() {
      for (const client of sockets) client.close(); sockets.clear();
      let cleanupError;
      try { await disposeRuntime(); } catch (error) { cleanupError = error; }
      try { await stopSource(); } catch (error) { cleanupError ||= error; }
      await killOwnedWorkers(); await rm(root, { recursive: true, force: true });
      if (cleanupError) throw cleanupError;
    }
    await restart();
    return { root, jobId, input, trace, restart, start, read, api, socket, stop,
      database: () => { if (purpose !== "replacement-archive") throw new Error("This fixed fixture has no D1"); return runtime.getD1Database("AGENT_AUDIT"); },
      async destroySource() { if (purpose !== "replacement-archive") throw new Error("This fixed fixture cannot replace its source"); await stopSource(); await rm(path.join(root, "journals"), { recursive: true, force: true }); },
      release: (phase) => writeFile(phase === 1 ? gate1 : gate2, "continue"),
      phaseReady: (phase) => waitFor(() => readFile(phase === 1 ? phase1 : phase2).then(() => true, () => false), Boolean),
      launches: () => readFile(launched, "utf8").then((text) => text.trim().split(/\s+/).length),
      sourceAlive: () => supervisor?.exitCode === null && supervisor?.signalCode === null,
      sourceIdentity: async () => { const value = JSON.parse(await readFile(path.join(root, "journals", jobId, "meta.json"), "utf8")); return { jobId: value.jobId, digest: value.digest, bootId: value.bootId, supervisorPid: value.supervisorPid, supervisorStart: value.supervisorStart }; },
      async attach() { let starts = 0; const frames = [];
        const result = await adapter.executeJournaled({ startExecution: async () => { starts++; throw new Error("Attach must not START"); }, readExecution: async (key, after) => { if (key !== jobId) throw new Error("Wrong source job"); return control("read", after); }, cancelExecution: async () => control("cancel") }, input.command,
          { cwd: root, journal: { jobId, deadline: input.deadline, mode: "attach", observationDeadline: input.deadline + 1_000 }, onJournalFrame: async (frame) => { frames.push(frame); } });
        return { result, starts, frames };
      },
    };
  } catch (error) {
    await disposeRuntime().catch(() => {}); await killOwnedWorkers();
    await stopSource().catch(() => {});
    await rm(root, { recursive: true, force: true }); throw error;
  }
}
