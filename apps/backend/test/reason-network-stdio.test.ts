import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const COMPANION = pathToFileURL(fileURLToPath(new URL("../../../scripts/reason-network-companion.mjs", import.meta.url))).href;

it.each(["request", "notification"])("handles a %s EPIPE after the writable check without crashing its host", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shiba-mcp-pipe-"));
  const executable = path.join(root, "fake-mcp");
  const host = path.join(root, "host.mjs");
  await writeFile(executable, `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line',(line)=>{
  const rpc=JSON.parse(line);
  if(rpc.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{}})+'\\n');
});
`, { mode: 0o755 });
  // Actual child and Writable stream; inject callback failure plus error event after the writable guard.
  await writeFile(host, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const spawn=cp.spawn;
cp.spawn=(...args)=>{
  const child=spawn(...args), write=child.stdin.write.bind(child.stdin);
  child.stdin.write=(line,callback)=>{
    const rpc=JSON.parse(line);
    if(rpc.method===${JSON.stringify(mode === "request" ? "tools/list" : "notifications/initialized")}){
      queueMicrotask(()=>{const error=Object.assign(new Error('fixture broken pipe'),{code:'EPIPE'});callback?.(error);child.stdin.emit('error',error);});
      return false;
    }
    return write(line,callback);
  };
  return child;
};
syncBuiltinESMExports();
const {connectReasonNetworkStdio}=await import(${JSON.stringify(COMPANION)});
if(${JSON.stringify(mode)}==='notification'){
  await assert.rejects(connectReasonNetworkStdio({executablePath:${JSON.stringify(executable)},timeoutMs:2000}),{code:'EPIPE'});
}else{
  const client=await connectReasonNetworkStdio({executablePath:${JSON.stringify(executable)},timeoutMs:2000});
  try{
    const settled=await Promise.allSettled([client.listTools(),client.callTool({name:'send_message',arguments:{},_meta:{sessionId:'fixture'}})]);
    assert.deepEqual(settled.map(x=>x.status),['rejected','rejected']);
    assert.equal(settled[0].reason.code,'EPIPE');assert.equal(settled[1].reason.code,'EPIPE');
    await assert.rejects(client.listTools(),/unavailable/);
  }finally{await client.close();}
}
console.log('handled EPIPE');
`);
  try {
    const result = await exec(process.execPath, [host], { timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: os.tmpdir() } });
    expect(result.stdout).toContain("handled EPIPE");
    expect(result.stderr).not.toContain("Unhandled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
