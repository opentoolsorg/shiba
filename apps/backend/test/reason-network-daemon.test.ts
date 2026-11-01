import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const DAEMON = fileURLToPath(new URL("../../../scripts/shiba-local-daemon.mjs", import.meta.url));

it.each(["connect-fail", "stdin-closed", "list-fail", "check-fail", "cancelled", "send-loss"])(
  "records the actual send_message boundary for %s without joining a network", async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "shiba-reason-daemon-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const trace = path.join(root, "rpc.jsonl");
    const executable = path.join(bin, "fake-reason");
    await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
if(${JSON.stringify(mode)}==='connect-fail')process.exit(2);
const readline=require('node:readline').createInterface({input:process.stdin});
process.stdin.on('error',()=>{});
readline.on('line',(line)=>{
  const rpc=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(rpc)+'\\n');
  const reply=(result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\\n');
  if(rpc.method==='initialize'){
    reply({});
  }else if(rpc.method==='tools/list'){
    if(${JSON.stringify(mode)}==='list-fail')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-1,message:'fixture discovery failure'}})+'\\n');
    else reply({tools:[{name:'send_message'}]});
  }else if(rpc.method==='tools/call')process.exit(3);
});
setInterval(()=>{},1000);
`, { mode: 0o755 });
    let claims = 0;
    let checks = 0;
    const results: Array<{ state: string; operationId: string }> = [];
    const operation = { operationId: "fixture-operation", claimToken: "fixture-claim", sessionId: "fixture-session", destination: "fixture-peer", message: "fixture approved body", idempotencyKey: "original-key" };
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/local/reason-network/v1/claim") { claims++; response.end(JSON.stringify({ operation })); }
      else if (request.url?.includes("/operations/")) {
        checks++;
        if (mode === "check-fail" && checks === 3) { response.statusCode = 500; response.end('{"error":"fixture status failure"}'); }
        else response.end(JSON.stringify({ state: "claimed", cancelRequested: mode === "cancelled" && checks === 3, sendAllowed: true }));
      } else {
        if (request.url === "/api/local/reason-network/v1/result") results.push(JSON.parse(raw));
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const workerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(path.join(root, "config.json"), JSON.stringify({ workerUrl, adapterToken: "fixture-machine-token", machineId: "fixture-machine" }));
    const preload = path.join(root, "broken-pipe.mjs");
    await writeFile(preload, `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);if(args[0]===${JSON.stringify(executable)}){
  const write=child.stdin.write.bind(child.stdin);child.stdin.write=(line,callback)=>{
    if(JSON.parse(line).method==='notifications/initialized'){queueMicrotask(()=>{const error=Object.assign(new Error('fixture broken pipe'),{code:'EPIPE'});callback?.(error);child.stdin.emit('error',error);});return false;}
    return write(line,callback);
  };
}return child;};syncBuiltinESMExports();`);
    try {
      const result = await exec(process.execPath, [...(mode === "stdin-closed" ? ["--import", preload] : []), DAEMON, "--once"], {
        env: { PATH: bin, HOME: root, SHIBA_LOCAL_RUN_ROOT: root, SHIBA_REASON_NETWORK_COMPANION: "1", SHIBA_REASON_NETWORK_EXECUTABLE: executable },
        timeout: 10_000,
      });
      expect(claims).toBe(1);
      expect(results).toEqual([{ operationId: operation.operationId, claimToken: operation.claimToken, state: mode === "send-loss" ? "unknown" : mode === "cancelled" ? "cancelled" : "rejected" }]);
      const records = (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: unknown });
      const sends = records.filter((record) => record.method === "tools/call");
      if (mode === "send-loss") {
        expect(sends).toEqual([{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: { to: operation.destination, message: operation.message, idempotency_key: "original-key" }, _meta: { sessionId: operation.sessionId } } }]);
        expect(result.stderr).toContain("outcome is unknown");
      } else {
        expect(sends).toEqual([]);
        if (mode !== "cancelled") expect(result.stderr).toContain("was not sent");
      }
      expect(result.stderr).not.toContain("fixture-machine-token");
      expect(result.stderr).not.toContain("Unhandled 'error'");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000,
);
