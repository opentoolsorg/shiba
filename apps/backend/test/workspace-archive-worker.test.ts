import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { expect, it } from "vitest";

const WRANGLER = fileURLToPath(new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DELIVERABLES = fileURLToPath(new URL("../src/run-deliverables.ts", import.meta.url));
const DOWNLOAD = fileURLToPath(new URL("../src/artifact-download.ts", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

it("streams frozen ZIPs through native FixedLengthStream into local R2 with checksum and length enforcement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-archive-worker-"));
  let worker: ChildProcess | undefined;
  let logs = "";
  const workerSource = `import {persistWorkspaceArchive} from ${JSON.stringify(DELIVERABLES)};
import {handleArtifactDownload} from ${JSON.stringify(DOWNLOAD)};
export default {async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return new Response('ready');
  if (url.pathname === '/persist' && request.method === 'POST') {
    return Response.json(await persistWorkspaceArchive(env,
      {ownerId:'owner',runId:'approved',sandboxId:'isolated-fixture'}, await request.json()));
  }
  if (url.pathname === '/bad-checksum' || url.pathname === '/bad-length') {
    const badLength = url.pathname === '/bad-length';
    const {readable,writable} = new FixedLengthStream(badLength ? 2 : 1);
    const writer = writable.getWriter();
    const writing = (async()=>{await writer.write(Uint8Array.of(1));await writer.close();})();
    const storing = env.ARTIFACTS.put(url.pathname,readable,badLength ? {} : {sha256:'0'.repeat(64)});
    const results = await Promise.allSettled([writing,storing]);
    return Response.json({rejected:results[1].status==='rejected',present:await env.ARTIFACTS.head(url.pathname)!==null});
  }
  return await handleArtifactDownload(request,env) ?? new Response('missing',{status:404});
}};`;
  try {
    await fs.writeFile(path.join(root, "worker.mjs"), workerSource);
    const config = path.join(root, "wrangler.jsonc");
    await fs.writeFile(config, JSON.stringify({
      name: "workspace-archive-fixture", main: "worker.mjs", compatibility_date: "2026-06-01", compatibility_flags: ["nodejs_compat"],
      r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "workspace-archive-fixture" }],
      vars: { ARTIFACT_SIGNING_KEY: "local-fixture-artifact-signing-key-32-bytes", WORKER_HOSTNAME: "shiba.test" },
    }));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    worker = spawn(process.execPath, [WRANGLER, "dev", "--local", `--config=${config}`, `--persist-to=${path.join(root, "state")}`, `--port=${port}`, "--ip=127.0.0.1", "--inspector-port=0"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: { PATH: process.env.PATH ?? "", TMPDIR: os.tmpdir(), XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"), WRANGLER_LOG_PATH: path.join(root, "logs"), WRANGLER_SEND_METRICS: "false", CI: "1" },
    });
    worker.stdout?.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-12_000); });
    worker.stderr?.on("data", (chunk) => { logs = (logs + String(chunk)).slice(-12_000); });
    const until = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < until) {
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Local Worker exited: ${logs}`);
      try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Local Worker did not start: ${logs}`);
    const binary = Buffer.alloc(150_000, 255);
    for (const files of [[], [
      { path: "out/report.txt", content: "Frozen report", encoding: "utf8" },
      { path: "out/empty.bin", content: "", encoding: "base64" },
      { path: "out/image.bin", content: binary.toString("base64"), encoding: "base64" },
    ]]) {
      const response = await fetch(`${base}/persist`, { method: "POST", body: JSON.stringify(files) });
      expect(response.status, await response.clone().text()).toBe(200);
      const bundle = await response.json() as { bytes: number; sha256: string; fileCount: number; downloadUrl: string };
      const link = new URL(bundle.downloadUrl);
      expect(link.searchParams.has("token")).toBe(false);
      const download = await fetch(new URL(link.pathname, base), { method: "POST", body: new URLSearchParams(link.hash.slice(1)) });
      expect(download.status).toBe(200);
      const bytes = new Uint8Array(await download.arrayBuffer());
      expect(bytes.byteLength).toBe(bundle.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundle.sha256);
      const entries = unzipSync(bytes);
      expect(Object.keys(entries)).toHaveLength(files.length);
      if (files.length) {
        const image = entries["image.bin"];
        if (!image) throw new Error("Expected binary ZIP entry is missing.");
        expect(createHash("sha256").update(image).digest("hex")).toBe(createHash("sha256").update(binary).digest("hex"));
      }
      else expect(bytes.byteLength).toBe(22);
    }
    for (const route of ["bad-checksum", "bad-length"]) {
      expect(await (await fetch(`${base}/${route}`)).json()).toEqual({ rejected: true, present: false });
    }
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const child = worker;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const terminate = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const force = setTimeout(() => terminate("SIGKILL"), 5000);
      terminate("SIGTERM");
      try { await closed; } finally { clearTimeout(force); }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
