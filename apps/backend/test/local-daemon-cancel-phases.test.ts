import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LOCAL_RUN_ROOT_TOKEN } from "@shiba/shared";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it.each(["collect-cancel", "collect-deadline", "test-cancel", "test-deadline", "test-denied", "test-stop-denied"])(
  "enforces execution-wide cancellation across the native %s phase",
  async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shiba-cancel-phase-"));
    const repo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    const operatorHome = path.join(root, "operator-home");
    const runRoot = path.join(root, "run");
    const work = path.join(runRoot, "runs", "phase-run", "work");
    await mkdir(repo); await mkdir(bin); await mkdir(operatorHome);
    await exec("git", ["init", "-b", "main", repo]);
    await writeFile(path.join(repo, "README.md"), "before\n");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const collecting = mode.startsWith("collect");
    // test-deadline races the command timeout with the execution deadline.
    // Both must share one termination/escalation or macOS can return EPERM
    // on the second group kill, crashing the daemon before result settlement.
    const deadline = mode.endsWith("deadline");
    const denied = mode.endsWith("denied");
    const stopping = mode.includes("stop");
    const deniedSignals = path.join(root, "denied-signals.mjs");
    await writeFile(deniedSignals, `import { existsSync } from 'node:fs';
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && signal === 'SIGKILL' && existsSync(${JSON.stringify(path.join(work, ".git/test-ignored-sigterm"))})) throw Object.assign(new Error('fixture denial'), { code: 'EPERM' });
        return kill(pid, signal);
      };`);
    await writeFile(path.join(bin, "git"), [
      `#!${process.execPath}`,
      "const fs=require('node:fs'), cp=require('node:child_process');",
      `const args=process.argv.slice(2); const collecting=${collecting};`,
      `const run=()=>{const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1)};`,
      "if(collecting && args.includes('status')){",
      "  const directory=args[args.indexOf('-C')+1];",
      "  fs.writeFileSync(require('node:path').join(directory,'.git/collect-started'),'yes');",
      "  process.on('SIGTERM',()=>{});",
      `  setTimeout(run,${deadline ? 6000 : 1400});`,
      "}else run();",
    ].join("\n"), { mode: 0o755 });
    await writeFile(path.join(bin, "codex"), [
      `#!${process.execPath}`,
      "if(process.argv.includes('--version'))process.exit(0);",
      "require('node:fs').writeFileSync('README.md','after\\n');",
      "console.log('harness finished');",
    ].join("\n"), { mode: 0o755 });
    await writeFile(path.join(bin, "approved-test"), [
      `#!${process.execPath}`,
      "const fs=require('node:fs'),path=require('node:path');",
      "fs.writeFileSync('.git/test-started','yes');",
      "fs.writeFileSync('.git/test-parent-pid',String(process.pid));",
      `if(${collecting})process.exit(0);`,
      "const sentinel=path.resolve('.git/test-grandchild-sentinel');",
      "const childCode='process.on(\"SIGTERM\",()=>{});setInterval(()=>require(\"node:fs\").appendFileSync('+JSON.stringify(sentinel)+',\"x\"),25)';",
      "const child=require('node:child_process').spawn(process.execPath,['-e',childCode],{stdio:'ignore'});",
      "fs.writeFileSync('.git/test-grandchild-pid',String(child.pid));",
      "process.on('SIGTERM',()=>fs.writeFileSync('.git/test-ignored-sigterm','yes'));",
      "setInterval(()=>{},100);",
    ].join("\n"), { mode: 0o755 });

    type Result = { status: string; summary: string; exitCode: number };
    let result: Result | undefined;
    let revoked = false;
    let claims = 0;
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw || "{}");
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/local/claim") {
        claims += 1;
        response.end(JSON.stringify({ claimToken: "phase-claim", envelope: {
          sandboxId: "phase-run", harness: "codex", repoUrl: repo, baseBranch: "main",
          cloneDir: `${LOCAL_RUN_ROOT_TOKEN}/work`, homeDir: `${LOCAL_RUN_ROOT_TOKEN}/home`,
          env: {}, configFiles: [], setupCommands: [], setupAllowlist: [],
          execAllowlist: [["approved-test"]], argv: ["codex"], testCommand: ["approved-test"],
          deadlineAt: Date.now() + (deadline ? 3000 : 20000),
        } }));
      } else if (request.url === "/api/local/control" && !deadline
        && existsSync(path.join(work, collecting ? ".git/collect-started" : ".git/test-grandchild-sentinel"))) {
        if (stopping) {
          daemon.kill("SIGTERM");
          response.end("{}");
        } else {
          revoked = true;
          response.statusCode = 409;
          response.end('{"error":"claim cancelled"}');
        }
      } else {
        if (request.url === "/api/local/result") result = body.result;
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const unrelated = spawn(process.execPath, ["-e",
      "const server=require('node:http').createServer((q,r)=>r.end('operator listener alive'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const unrelatedPort = await new Promise<number>((resolve, reject) => {
      unrelated.once("error", reject);
      unrelated.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    });
    const daemon = spawn(process.execPath, [
      ...(denied ? ["--import", deniedSignals] : []),
      fileURLToPath(new URL("../../../scripts/shiba-local-daemon.mjs", import.meta.url)),
      ...(denied ? [] : ["--once"]),
    ], {
      env: { ...process.env, HOME: operatorHome, PATH: `${bin}:${process.env.PATH}`,
        SHIBA_LOCAL_RUN_ROOT: runRoot, SHIBA_WORKER_URL: `http://127.0.0.1:${address.port}`,
        LOCAL_ADAPTER_TOKEN: "phase-control-secret" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    daemon.stdout.on("data", (chunk) => { output += String(chunk); });
    daemon.stderr.on("data", (chunk) => { output += String(chunk); });
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 12000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { daemon.once("error", reject); daemon.once("close", resolve); });
      if (exit === 70) {
        expect(result, output).toMatchObject({ status: "error", summary: expect.stringContaining("termination unconfirmed (SIGKILL: EPERM)") });
      } else {
        expect(exit, output).toBe(denied ? 70 : 1);
        expect(result, output).toMatchObject({ status: "error", summary: expect.stringContaining(deadline ? "deadline" : "revoked or cancelled") });
      }
      expect(claims).toBe(1);
      if (denied) {
        expect(result?.summary).toContain("SIGKILL: EPERM");
        expect(result?.summary).toContain("child processes may still be running");
      }
      if (!deadline && !stopping) expect(revoked).toBe(true);
      if (collecting) {
        expect(existsSync(path.join(work, ".git/collect-started"))).toBe(true);
        expect(existsSync(path.join(work, ".git/test-started"))).toBe(false);
      } else {
        expect(existsSync(path.join(work, ".git/test-started"))).toBe(true);
        expect(existsSync(path.join(work, ".git/test-ignored-sigterm"))).toBe(true);
        const sentinel = path.join(work, ".git/test-grandchild-sentinel");
        const before = await readFile(sentinel, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 200));
        const after = await readFile(sentinel, "utf8");
        if (denied) expect(after.length).toBeGreaterThan(before.length);
        else expect(after).toBe(before);
      }
      expect(unrelated.exitCode).toBeNull();
      expect(await (await fetch(`http://127.0.0.1:${unrelatedPort}`)).text()).toBe("operator listener alive");
      expect(output).not.toContain("phase-control-secret");
    } finally {
      clearTimeout(timer); daemon.kill("SIGKILL"); unrelated.kill("SIGKILL");
      for (const file of denied ? [".git/test-grandchild-pid", ".git/test-parent-pid"] : [".git/test-grandchild-pid"]) {
        try {
          const pid = Number(await readFile(path.join(work, file), "utf8"));
          if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
        } catch {}
      }
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15000,
);
