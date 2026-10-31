/**
 * T61 daemon single-instance lock + graceful stop, run against the real
 * script. SHIBA_WORKER_URL points at a dead port so instance A retries its
 * claim forever and stays alive for the lock assertions.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DAEMON = fileURLToPath(new URL("../../../scripts/shiba-local-daemon.mjs", import.meta.url));

function startDaemon(root: string, args: string[] = [], workerUrl = "http://127.0.0.1:9") {
  const child = spawn(process.execPath, [DAEMON, "--poll", "500", ...args], {
    env: {
      ...process.env,
      SHIBA_LOCAL_RUN_ROOT: root,
      SHIBA_WORKER_URL: workerUrl,
      LOCAL_ADAPTER_TOKEN: "test-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, stderr: () => stderr };
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("shiba-local-daemon lock", () => {
  it("a second instance exits 75, and SIGTERM removes the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-"));
    const lock = join(root, "daemon.lock");
    const a = startDaemon(root);
    await waitFor(() => existsSync(lock), "instance A to take the lock");
    const b = startDaemon(root);
    expect(await b.exited).toBe(75);
    expect(b.stderr()).toContain("another shiba-local daemon is running");
    a.child.kill("SIGTERM");
    expect(await a.exited).toBe(143);
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  it("--help exits 0 without creating a lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-"));
    const help = startDaemon(root, ["--help"]);
    expect(await help.exited).toBe(0);
    expect(existsSync(join(root, "daemon.lock"))).toBe(false);
  });

  const bootAt = () => Math.round(Date.now() - uptime() * 1000);
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

  it.each([
    ["a dead pid", () => JSON.stringify({ pid: deadPid(), at: Date.now(), bootAt: bootAt() })],
    ["a live pid from a previous boot", () => JSON.stringify({ pid: process.pid, at: 0, bootAt: bootAt() - 3_600_000 })],
    ["garbage content", () => "not json{"],
  ])("takes over a stale lock holding %s", async (_label, content) => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-"));
    const lock = join(root, "daemon.lock");
    writeFileSync(lock, content());
    const a = startDaemon(root);
    const holder = () => {
      try {
        return JSON.parse(readFileSync(lock, "utf8")).pid;
      } catch {
        return null;
      }
    };
    await waitFor(() => holder() === a.child.pid, "the daemon to take the stale lock");
    a.child.kill("SIGTERM");
    expect(await a.exited).toBe(143);
  }, 30_000);

  it("exits 75 on a live lock written this boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-"));
    const lock = join(root, "daemon.lock");
    const content = JSON.stringify({ pid: process.pid, at: Date.now(), bootAt: bootAt() });
    writeFileSync(lock, content);
    const b = startDaemon(root);
    expect(await b.exited).toBe(75);
    expect(readFileSync(lock, "utf8")).toBe(content);
  }, 30_000);
});

describe("shiba-local-daemon result post", () => {
  it("retries a 500 and settles on the next 200", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-"));
    let resultPosts = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/api/local/claim") {
          const envelope = {
            sandboxId: "sbx-retry",
            harness: "claude",
            // A missing repo fails the clone fast; the error result is what gets posted.
            repoUrl: join(root, "no-such-repo"),
            baseBranch: "main",
            cloneDir: join(root, "runs", "sbx-retry", "work"),
            homeDir: join(root, "runs", "sbx-retry", "home"),
            env: {},
            deadlineAt: Date.now() + 60_000,
            setupCommands: [],
            setupAllowlist: [],
            configFiles: [],
            argv: ["true"],
            execAllowlist: [],
          };
          res.end(JSON.stringify({ envelope, claimToken: "tok" }));
        } else if (req.url === "/api/local/result") {
          resultPosts += 1;
          res.statusCode = resultPosts === 1 ? 500 : 200;
          res.end(resultPosts === 1 ? "boom" : "{}");
        } else {
          res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const d = startDaemon(root, ["--once"], `http://127.0.0.1:${port}`);
      // --once exits 1 for an errored run, after the result is settled.
      expect(await d.exited).toBe(1);
      expect(resultPosts).toBe(2);
      expect(d.stderr()).toContain("result post attempt 1 failed");
      expect(d.stderr()).not.toContain("result post failed");
    } finally {
      server.close();
    }
  }, 30_000);
});

describe("shiba-local-daemon operator errors", () => {
  it("exits 79 when /api/local/pair returns 404 (runtime off)", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-off-"));
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found." }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const d = startDaemon(root, ["--connect", `http://127.0.0.1:${port}`, "--pair", "nonce.sig"], `http://127.0.0.1:${port}`);
      expect(await d.exited).toBe(79);
      expect(d.stderr()).toMatch(/local runtime is not enabled/i);
    } finally {
      server.close();
    }
  }, 15_000);

  it("exits 76 when the Worker returns an HTML Access page", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-access-"));
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ workerUrl: "http://127.0.0.1:1", adapterToken: "tok", machineId: "m1" }),
    );
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end("<!doctype html><title>Cloudflare Access</title>");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      const d = spawn(process.execPath, [DAEMON, "--once", "--poll", "200"], {
        env: {
          ...process.env,
          SHIBA_LOCAL_RUN_ROOT: root,
          SHIBA_WORKER_URL: url,
          LOCAL_ADAPTER_TOKEN: undefined,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      d.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => d.on("exit", resolve));
      expect(code).toBe(76);
      expect(stderr).toMatch(/HTML login page/i);
    } finally {
      server.close();
    }
  }, 15_000);

  it("exits 77 on an invalid pairing token (401 JSON)", async () => {
    const root = mkdtempSync(join(tmpdir(), "shiba-daemon-pair-"));
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Pairing token is invalid or expired." }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const d = startDaemon(root, ["--connect", `http://127.0.0.1:${port}`, "--pair", "bad.token"], `http://127.0.0.1:${port}`);
      expect(await d.exited).toBe(77);
      expect(d.stderr()).toMatch(/pairing token expired/i);
    } finally {
      server.close();
    }
  }, 15_000);
});

describe("shiba-local-daemon Reason capability heartbeat", () => {
  it("advertises a validated fake executable and withdraws the capability when opt-in is disabled", async () => {
    const root=mkdtempSync(join(tmpdir(),"shiba-reason-heartbeat-"));
    const executable=join(root,"reason-network-fake");
    writeFileSync(executable,"#!/bin/sh\nexit 0\n");chmodSync(executable,0o755);
    const heartbeats:Array<Record<string,unknown>>=[];
    const server=createServer((req,res)=>{
      let body="";req.setEncoding("utf8");req.on("data",(chunk:string)=>body+=chunk);
      req.on("end",()=>{
        if(req.url==="/api/local/heartbeat")heartbeats.push(JSON.parse(body) as Record<string,unknown>);
        if(req.url==="/api/local/reason-network/v1/claim")res.end(JSON.stringify({operation:null}));
        else if(req.url==="/api/local/claim")res.end(JSON.stringify({envelope:null}));
        else res.end("{}");
      });
    });
    await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));
    const {port}=server.address() as AddressInfo;
    writeFileSync(join(root,"config.json"),JSON.stringify({workerUrl:`http://127.0.0.1:${port}`,adapterToken:"paired-test-token",machineId:"paired-machine-test"}));
    const run=async(enabled:boolean)=>{
      const env: NodeJS.ProcessEnv={...process.env,SHIBA_LOCAL_RUN_ROOT:root,SHIBA_WORKER_URL:`http://127.0.0.1:${port}`,SHIBA_REASON_NETWORK_COMPANION:enabled?"1":"0",SHIBA_REASON_NETWORK_EXECUTABLE:executable};
      env.LOCAL_ADAPTER_TOKEN = undefined;
      const child=spawn(process.execPath,[DAEMON,"--once"],{env,stdio:["ignore","ignore","pipe"]});
      let stderr="";child.stderr.on("data",(chunk)=>stderr+=chunk.toString());
      const code=await new Promise<number|null>((resolve)=>child.on("exit",resolve));
      expect(code,stderr).toBe(0);
    };
    try{
      await run(true);
      await run(false);
      expect(heartbeats.map((heartbeat)=>heartbeat.reasonNetworkCompanion)).toEqual([true,false]);
      expect(heartbeats.every((heartbeat)=>heartbeat.machineId==="paired-machine-test")).toBe(true);
    }finally{server.close();}
  },30_000);
});
