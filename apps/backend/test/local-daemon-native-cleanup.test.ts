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

it.each([false, true])("confirms native provider cleanup before settlement (SIGKILL denied: %s)", async (denyKill) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-native-cleanup-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const operatorHome = path.join(root, "operator-home");
  const providerPidFile = path.join(root, "provider.pid");
  const successMarker = path.join(root, "turn-success");
  const ignoredTerm = path.join(root, "ignored-term");
  const deniedMarker = path.join(root, "kill-denied");
  const heartbeat = path.join(root, "provider-heartbeat");
  await mkdir(repo); await mkdir(bin); await mkdir(operatorHome);
  await exec("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "before\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  await writeFile(path.join(bin, "codex"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const provider = path.join(root, "native-provider.mjs");
  await writeFile(provider, [
    "import fs from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    `fs.writeFileSync(${JSON.stringify(providerPidFile)},String(process.pid));`,
    `process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(ignoredTerm)},'ignored'));`,
    `setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),25);`,
    "let finished=false;",
    "createInterface({input:process.stdin}).on('line',(line)=>{",
    "  const message=JSON.parse(line); if(finished||message.type!=='user')return; finished=true;",
    "  fs.writeFileSync('README.md','after native turn\\n');",
    `  fs.writeFileSync(${JSON.stringify(successMarker)},'native turn succeeded');`,
    "  console.log(JSON.stringify({type:'result',result:'native fixture completed successfully'}));",
    "});",
    "console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-cleanup-session'}));",
  ].join("\n"));
  const preloader = path.join(root, "deny-owned-kill.mjs");
  await writeFile(preloader, [
    "import fs from 'node:fs';",
    "import { ChildProcess } from 'node:child_process';",
    "const originalKill=process.kill.bind(process), originalChildKill=ChildProcess.prototype.kill;",
    "function deny(pid,signal){",
    `  if(!${denyKill}||signal!=='SIGKILL'||!fs.existsSync(${JSON.stringify(successMarker)}))return;`,
    `  const providerPid=Number(fs.readFileSync(${JSON.stringify(providerPidFile)},'utf8'));`,
    "  if(Math.abs(pid)!==providerPid)return;",
    `  fs.appendFileSync(${JSON.stringify(deniedMarker)},String(pid)+'\\n');`,
    "  throw Object.assign(new Error('fixture denies SIGKILL for native provider'),{code:'EPERM'});",
    "}",
    "process.kill=(pid,signal)=>{deny(pid,signal);return originalKill(pid,signal)};",
    "ChildProcess.prototype.kill=function(signal){deny(this.pid,signal);return originalChildKill.call(this,signal)};",
  ].join("\n"));

  type Result = { status: string; summary: string; exitCode: number };
  const results: Result[] = [];
  const aliveAtSettlement: boolean[] = [];
  let claims = 0;
  let stopAfterUnexpectedClaim = () => {};
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw || "{}");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/local/claim") {
      claims += 1;
      if (claims > 1) {
        response.end('{"envelope":null}');
        stopAfterUnexpectedClaim();
        return;
      }
      response.end(JSON.stringify({ claimToken: "native-claim", envelope: {
        sandboxId: "native-cleanup", harness: "codex", repoUrl: repo, baseBranch: "main",
        cloneDir: `${LOCAL_RUN_ROOT_TOKEN}/work`, homeDir: `${LOCAL_RUN_ROOT_TOKEN}/home`,
        env: {}, configFiles: [], setupCommands: [], setupAllowlist: [], execAllowlist: [],
        argv: ["codex"], deadlineAt: Date.now() + 20_000, task: "Complete the native fixture turn",
        session: { provider: "claude", model: "fixture-only", permissionMode: "approval-required", bin: process.execPath, binArgs: [provider] },
      } }));
    } else {
      if (request.url === "/api/local/result") {
        results.push(body.result);
        const pid = Number(await readFile(providerPidFile, "utf8"));
        try { process.kill(pid, 0); aliveAtSettlement.push(true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; aliveAtSettlement.push(false); }
      }
      response.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  const unrelated = spawn(process.execPath, ["-e",
    "const s=require('node:http').createServer((q,r)=>r.end('unrelated listener alive'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const unrelatedPort = await new Promise<number>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
  });
  const daemon = spawn(process.execPath, ["--import", preloader,
    fileURLToPath(new URL("../../../scripts/shiba-local-daemon.mjs", import.meta.url)), ...(denyKill ? ["--poll", "500"] : ["--once"]),
  ], {
    env: { ...process.env, HOME: operatorHome, PATH: `${bin}:${process.env.PATH}`,
      SHIBA_LOCAL_RUN_ROOT: path.join(root, "run"), SHIBA_WORKER_URL: `http://127.0.0.1:${address.port}`,
      LOCAL_ADAPTER_TOKEN: "native-fixture-control-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stopAfterUnexpectedClaim = () => { daemon.kill("SIGTERM"); };
  let output = "";
  daemon.stdout.on("data", (chunk) => { output += String(chunk); });
  daemon.stderr.on("data", (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => daemon.kill("SIGKILL"), 12_000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { daemon.once("error", reject); daemon.once("close", resolve); });
    expect(existsSync(successMarker), output).toBe(true);
    expect(existsSync(ignoredTerm), output).toBe(true);
    expect(results, output).toHaveLength(1);
    if (denyKill) {
      expect(existsSync(deniedMarker), output).toBe(true);
      expect(exit, output).toBe(70);
      expect(results[0]).toMatchObject({ status: "error", summary: expect.stringMatching(/termination unconfirmed/i) });
      expect(results[0]?.summary).toMatch(/child processes may still be running/i);
      expect(results.some((result) => result.status === "completed")).toBe(false);
      expect(claims, output).toBe(1);
      expect(aliveAtSettlement).toEqual([true]);
    } else {
      expect(exit, output).toBe(0);
      expect(results[0]).toMatchObject({ status: "completed", exitCode: 0, summary: expect.stringContaining("native fixture completed successfully") });
      expect(aliveAtSettlement, "Provider must be reaped before publishing completed.").toEqual([false]);
      const before = await readFile(heartbeat, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readFile(heartbeat, "utf8")).toBe(before);
    }
    expect(unrelated.exitCode).toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${unrelatedPort}`, { signal: AbortSignal.timeout(1000) })).text()).toBe("unrelated listener alive");
    expect(output).not.toContain("native-fixture-control-secret");
  } finally {
    clearTimeout(timer); daemon.kill("SIGKILL"); unrelated.kill("SIGKILL");
    try {
      const pid = Number(await readFile(providerPidFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    } catch {}
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
