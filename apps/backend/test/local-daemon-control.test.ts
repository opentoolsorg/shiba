import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it.each(["claim-revoked", "deadline", "receipts-reset"])("enforces the real daemon's %s boundary", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-daemon-control-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const runRoot = path.join(root, "run");
  await mkdir(repo); await mkdir(bin);
  await exec("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  // Production uses the canonical claude-code harness name; provider auth
  // is permitted but the daemon's control bearer must remain absent.
  await writeFile(path.join(bin, "claude"), [
    `#!${process.execPath}`,
    "const fs=require('node:fs');",
    "if(process.argv.includes('--version'))process.exit(0);",
    "if(process.env.LOCAL_ADAPTER_TOKEN||process.env.ANTHROPIC_API_KEY!=='fixture-provider-key')process.exit(42);",
    "if(process.argv.includes('--finish'))setTimeout(()=>{console.log('fixture completed');process.exit(0)},700);",
    "fs.writeFileSync('.git/cli-started','yes');",
    "const sentinel=require('node:path').resolve('.git/grandchild-sentinel');",
    "const grandchild=require('node:child_process').spawn(process.execPath,['-e',`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(sentinel)},'x'),30)`],{stdio:'ignore'});",
    "fs.writeFileSync('.git/grandchild-pid',String(grandchild.pid));",
    "process.on('SIGTERM',()=>{fs.writeFileSync('.git/cli-stopped','yes');process.exit(0)});",
    "setInterval(()=>{},100);",
  ].join("\n"), { mode: 0o755 });
  type Result = { status: string; summary: string; signals?: { kind: string }[] };
  let result: Result | undefined;
  const results: Result[] = [];
  let claims = 0;
  let staleControl: ServerResponse | undefined;
  const work = path.join(runRoot, "runs", "control-test", "work");
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/local/claim") {
      claims += 1;
      if (mode === "receipts-reset" && claims > 2) { response.end('{"envelope":null}'); return; }
      response.end(JSON.stringify({ claimToken: "claim", envelope: {
        sandboxId: "control-test", harness: "claude-code", repoUrl: repo, baseBranch: "main",
        cloneDir: "${SHIBA_LOCAL_RUN_ROOT}/work", homeDir: "${SHIBA_LOCAL_RUN_ROOT}/home",
        env: {}, configFiles: [],
        setupCommands: mode === "receipts-reset" && claims === 1 ? [["git", "--version"]] : [],
        setupAllowlist: [["git"]], execAllowlist: [], argv: mode === "receipts-reset" ? ["claude", "--finish"] : ["claude"],
        deadlineAt: Date.now() + (mode === "deadline" ? 1500 : 20000),
      } }));
    } else if (request.url === "/api/local/control" && mode === "receipts-reset" && claims === 1) {
      // Finish run one while its control request is still in flight. The
      // eventual revoked response must never target run two's active CLI.
      staleControl = response;
      return;
    } else if (request.url === "/api/local/control" && mode === "receipts-reset" && staleControl) {
      staleControl.statusCode = 409; staleControl.end('{"error":"old claim expired"}'); staleControl = undefined;
      response.end("{}");
    } else if (request.url === "/api/local/control" && mode === "claim-revoked" && existsSync(path.join(work, ".git/cli-started"))) {
      response.statusCode = 409; response.end(JSON.stringify({ error: "claim revoked" }));
    } else {
      if (request.url === "/api/local/result") { result = body.result; results.push(body.result); }
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
  const daemon = spawn(process.execPath, [path.resolve("../../scripts/shiba-local-daemon.mjs"), ...(mode === "receipts-reset" ? ["--poll", "500"] : ["--once"])], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIBA_LOCAL_RUN_ROOT: runRoot,
      SHIBA_WORKER_URL: `http://127.0.0.1:${address.port}`, LOCAL_ADAPTER_TOKEN: "fixture-control-key", ANTHROPIC_API_KEY: "fixture-provider-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; daemon.stdout.on("data", (chunk) => {
    output += chunk;
    if (mode === "receipts-reset" && (output.match(/settled control-test/g) ?? []).length >= 2) daemon.kill("SIGTERM");
  }); daemon.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => daemon.kill("SIGKILL"), 12000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { daemon.on("error", reject); daemon.on("close", resolve); });
    if (mode === "receipts-reset") {
      expect(exit, output).toBe(143);
      expect(results).toHaveLength(2);
      expect(results.map((item) => item.status)).toEqual(["completed", "completed"]);
      expect(results[0]?.signals?.some((signal) => signal.kind === "exec.settled")).toBe(true);
      expect(results[1]?.signals?.some((signal) => signal.kind === "exec.settled")).toBe(false);
    } else {
      if (exit === 70) {
        expect(result, output).toMatchObject({ status: "error", summary: expect.stringContaining("termination unconfirmed (SIGKILL: EPERM)") });
      } else {
        expect(exit, output).toBe(1);
        expect(result).toMatchObject({ status: "error", summary: expect.stringContaining(mode === "deadline" ? "deadline" : "revoked or cancelled") });
      }
      expect(existsSync(path.join(work, ".git/cli-stopped"))).toBe(true);
      const sentinel = path.join(work, ".git/grandchild-sentinel");
      const before = await readFile(sentinel, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await readFile(sentinel, "utf8")).toBe(before);
    }
    expect(unrelated.exitCode).toBeNull();
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    expect(output).not.toContain("fixture-control-key");
  } finally {
    clearTimeout(timer); daemon.kill(); unrelated.kill("SIGKILL");
    staleControl?.end('{"error":"fixture stopped"}');
    try {
      const pid = Number(await readFile(path.join(work, ".git/grandchild-pid"), "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } catch {}
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
