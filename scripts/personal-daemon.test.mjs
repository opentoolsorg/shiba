import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { probePersonalAccount } from "./personal-cli-auth.mjs";

const daemon = fileURLToPath(new URL("./shiba-local-daemon.mjs", import.meta.url));
async function fixture(t, mode = "idle") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-personal-daemon-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const user = path.join(root, "user"), state = path.join(root, "state"), bin = path.join(root, "bin"), log = path.join(root, "requests.jsonl"), gitLog = path.join(root, "git.jsonl"), started = path.join(root, "started.json"), effect = path.join(root, "effect.json"), hook = path.join(root, "worker-hook.mjs");
  for (const folder of [user, state, bin, path.join(user, ".codex")]) await fs.mkdir(folder, { recursive: true });
  const credential = { auth_mode: "chatgpt", tokens: { access_token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`, refresh_token: "FAKE_PERSONAL_REFRESH", account_id: "account-one" } };
  await fs.writeFile(path.join(user, ".codex/auth.json"), JSON.stringify(credential));
  const codex = `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.157.1');process.exit(0);}
const rl=readline.createInterface({input:process.stdin});let client='';
rl.on('line',line=>{const m=JSON.parse(line);const reply=result=>console.log(JSON.stringify({id:m.id,result}));
if(m.method==='initialize'){client=m.params.clientInfo.name;reply({version:'fixture'});}
else if(m.method==='account/read'){if(m.params.refreshToken!==false)process.exit(2);reply({requiresOpenaiAuth:true,account:{type:'chatgpt',email:'one@example.test',planType:'pro'}});}
else if(m.method==='thread/start')reply({thread:{id:'thread-fixture'}});
else if(m.method==='turn/start'){fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid,envKeys:Object.keys(process.env),argv:process.argv,home:process.env.HOME,providerFile:fs.existsSync(process.env.HOME+'/.codex/auth.json'),otherFile:fs.existsSync(process.env.HOME+'/.claude/.credentials.json')}));reply({turn:{id:'turn-fixture'}});if(['complete','result-413','result-413-always'].includes(${JSON.stringify(mode)}))setTimeout(()=>console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-fixture',status:'completed'}}})),10);if(${JSON.stringify(mode)}.startsWith('permission-'))setTimeout(()=>console.log(JSON.stringify({id:'native-permission',method:'item/commandExecution/requestApproval',params:{itemId:'permission-item',command:${JSON.stringify(mode === "permission-secret" ? "echo FAKE_PERSONAL_REFRESH" : "echo safe")},reason:'fixture',cwd:process.cwd(),env:{SAFE_FLAG:'1'}}})),10);}
else if(m.id==='native-permission'&&m.result){if(m.result.decision==='accept')fs.writeFileSync(${JSON.stringify(effect)},'allowed');console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-fixture',status:'completed'}}}));}
else if(m.method==='turn/interrupt')reply({});
});`;
  await fs.writeFile(path.join(bin, "codex"), codex, { mode: 0o700 });
  await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}
import fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify({args,envKeys:Object.keys(process.env),home:process.env.HOME})+'\\n');
if(args.includes('clone')){fs.mkdirSync(args.at(-1)+'/.git',{recursive:true});}
else if(args.includes('--git-dir'))console.log('.git');else if(args.includes('rev-parse')||args.includes('write-tree')||args.includes('commit-tree'))console.log('a'.repeat(40));`, { mode: 0o700 });
  const env = { ...process.env, HOME: user, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHIBA_LOCAL_RUN_ROOT: state, OPENAI_API_KEY: "FAKE_AMBIENT_OPENAI_KEY", ANTHROPIC_API_KEY: "FAKE_AMBIENT_CLAUDE_KEY", GITHUB_TOKEN: "FAKE_GITHUB_KEY", GH_TOKEN: "FAKE_GH_KEY", OPENAI_BASE_URL: "https://unwanted.test" };
  delete env.LOCAL_ADAPTER_TOKEN; delete env.SHIBA_WORKER_URL; delete env.SHIBA_REASON_NETWORK_COMPANION;
  const receipt = await probePersonalAccount({ harness: "codex", userHome: user, sourceEnv: env });
  const origin = "https://shiba-fixture.example.test", scope = { version: 2, ownerAccountId: "owner-one", actorId: "one@example.test", workspaceId: `ws_${"a".repeat(24)}`, membershipVersion: 1, membershipRole: "member", origin };
  const config = { workerUrl: origin, adapterToken: "FAKE_MACHINE_TOKEN", machineId: "machine-one", personalExecution: { version: 1, scope }, personalSelection: { harness: "codex", billingMode: "native-subscription", accountFingerprint: receipt.accountFingerprint } };
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(hook, `import fs from 'node:fs';import fsp from 'node:fs/promises';let receipt,permission,claimed=false,resultCount=0;const mode=${JSON.stringify(mode)};
const realStat=fsp.lstat.bind(fsp);fsp.lstat=async(candidate,...args)=>{if(['/etc/codex/config.toml','/etc/codex/managed_config.toml','/etc/codex/requirements.toml'].includes(candidate))throw Object.assign(new Error('Fixture has no managed settings'),{code:'ENOENT'});return realStat(candidate,...args);};
globalThis.fetch=async(url,options)=>{if(!String(url).startsWith(${JSON.stringify(origin + "/api/local/")}))throw new Error('Unexpected fixture network request');const route=String(url).split('/').at(-1),body=JSON.parse(options.body??'{}');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({route,body,auth:options.headers.Authorization})+'\\n');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
if(options.headers.Authorization!=='Bearer FAKE_MACHINE_TOKEN')return response({error:'wrong token'},401);
if(route==='heartbeat')return response({ok:true});
if(route==='personal-account'){receipt=body.account;return response({ok:true},mode==='revoked'?401:200);}
if(route==='claim'){if(mode==='idle'||claimed)return response({envelope:null});claimed=true;
const now=Date.now(),snapshot={version:1,grantId:'plex_'+'a'.repeat(32),grantVersion:1,ownerAccountId:'owner-one',actorId:mode==='other-owner'?'two@example.test':'one@example.test',workspaceId:'ws_'+'a'.repeat(24),membershipVersion:1,machineId:'machine-one',machineRevision:1,harness:'codex',billingMode:'native-subscription',accountFingerprint:receipt.accountFingerprint,authVersion:receipt.authVersion,codingModel:'openai/gpt-5.4',repoUrl:'https://github.com/example/repo',expiresAt:now+60000,allowedPhases:['local_repository_task']};
return response({claimToken:'FAKE_CLAIM_TOKEN',envelope:{sandboxId:'fixture_run',orgId:'team:'+snapshot.workspaceId,customAgentId:'engineer',customAgentVersion:1,harness:'codex',repoUrl:snapshot.repoUrl,baseBranch:'main',cloneDir:'\u0024{SHIBA_LOCAL_RUN_ROOT}/work',homeDir:'\u0024{SHIBA_LOCAL_RUN_ROOT}/home',deadlineAt:now+60000,env:{},configFiles:[],setupCommands:[],argv:[],session:{provider:'codex',model:'gpt-5.4',permissionMode:'approval-required'},personalExecution:{snapshot,approvalId:'approval-1',inputHash:'a'.repeat(64),contextDigest:'b'.repeat(64),generation:0,executionOwner:'owner-1',handoffId:'handoff-1',approvedUntil:now+60000}}});}
if(route==='control'){if(mode==='before-clone-revoke'||(mode==='active-cancel'&&fs.existsSync(${JSON.stringify(started)})))return response({error:'revoked'},409);return response({interrupt:false});}
if(route==='approval'){if(body.request){permission=body.request;return response({actionHash:permission.actionHash,expiresAt:permission.expiresAt});}if(mode==='permission-replay')return response({error:'consumed'},409);return response({decision:'allow',actionHash:mode==='permission-mismatch'?'f'.repeat(64):permission.actionHash,expiresAt:permission.expiresAt});}
if(route==='events')return response({ok:true},mode==='events-413'?413:200);if(route==='result'){resultCount++;return response({ok:true},mode==='result-413-always'||(mode==='result-413'&&resultCount===1)?413:200);}throw new Error('Unexpected fixture route');};`);
  const run = async (extraArgs = [], extraEnv = {}) => {
    const child = spawn(process.execPath, ["--import", hook, daemon, "--once", ...extraArgs], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
    const code = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timeout);
    const requests = await fs.readFile(log, "utf8").then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), () => []);
    return { code, output, requests };
  };
  return { root, user, state, env, receipt, config, log, started, effect, gitLog, run };
}

test("actual personal daemon refreshes only its selected receipt and claims with machine bearer", async t => {
  const f = await fixture(t); const result = await f.run(); assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.requests.map(item => item.route), ["heartbeat", "personal-account", "claim"]);
  const account = result.requests[1].body.account; assert.equal(account.accountFingerprint, f.receipt.accountFingerprint);
  assert.deepEqual(Object.keys(result.requests[1].body), ["account"]);
  for (const forbidden of ["FAKE_PERSONAL_REFRESH", "account-one", "one@example.test", "FAKE_AMBIENT"]) assert.ok(!JSON.stringify(result.requests).includes(forbidden));
});
test("actual personal daemon refuses operator-token override before network or claim", async t => {
  const f = await fixture(t); const result = await f.run([], { LOCAL_ADAPTER_TOKEN: "FAKE_OPERATOR_TOKEN" });
  assert.equal(result.code, 64); assert.equal(result.requests.length, 0); assert.match(result.output, /cannot use operator/);
});
test("actual personal daemon refuses selected-account drift without a claim or provider fallback", async t => {
  const f = await fixture(t); const result = await f.run(["--personal-harness", "codex", "--personal-billing", "native-subscription", "--personal-account", "c".repeat(64)]);
  assert.equal(result.code, 1); assert.deepEqual(result.requests.map(item => item.route), ["heartbeat"]); assert.match(result.output, /selected personal account changed/);
});
test("actual revoked machine stops after receipt response without claim", async t => {
  const f = await fixture(t, "revoked"), result = await f.run();
  assert.equal(result.code, 78); assert.ok(!result.requests.some(item => item.route === "claim"));
});
for (const mode of ["other-owner", "before-clone-revoke"]) test(`actual daemon ${mode} has zero Git or CLI execution effects`, async t => {
  const f = await fixture(t, mode), result = await f.run(); assert.equal(result.code, 1, result.output);
  const settled = result.requests.find(item => item.route === "result"); assert.equal(settled.body.result.status, "error");
  await assert.rejects(fs.stat(f.gitLog)); await assert.rejects(fs.stat(f.started));
});
test("actual daemon cancellation stops its selected CLI group and cleans copied auth; unrelated process survives", async t => {
  const f = await fixture(t, "active-cancel");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); t.after(() => unrelated.kill("SIGKILL"));
  const result = await f.run(); assert.equal(result.code, 1, result.output);
  assert.ok(result.requests.some(item => item.route === "events"), JSON.stringify(result.requests.find(item => item.route === "result")?.body.result));
  const cli = JSON.parse(await fs.readFile(f.started, "utf8"));
  assert.ok(cli.providerFile); assert.equal(cli.otherFile, false);
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "LOCAL_ADAPTER_TOKEN", "OPENAI_BASE_URL", "NODE_OPTIONS"]) assert.ok(!cli.envKeys.includes(key), key);
  assert.ok(cli.argv.includes('model_provider="openai"')); assert.ok(cli.argv.includes("features.apps=false"));
  assert.throws(() => process.kill(cli.pid, 0)); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.ok(result.requests.some(item => item.route === "result" && item.body.result.status === "error"));
  await assert.rejects(fs.stat(path.join(f.state, "runs/fixture_run")));
  const git = (await fs.readFile(f.gitLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const clone = git.find(item => item.args.includes("clone")); assert.ok(clone.args.includes("credential.helper=")); assert.ok(clone.args.includes("--no-recurse-submodules"));
  assert.ok(!clone.envKeys.includes("GITHUB_TOKEN"));
});
test("actual daemon completed run persists result once and restart has no duplicate launch", async t => {
  const f = await fixture(t, "complete"), first = await f.run(); assert.equal(first.code, 0, JSON.stringify(first.requests.find(item => item.route === "result")?.body.result));
  assert.equal(first.requests.filter(item => item.route === "result").length, 1);
  await assert.rejects(fs.stat(path.join(f.state, "runs/fixture_run")));
  // Restart's mailbox is empty; this is a daemon fixture, not a claim-storage proof.
  const hookText = await fs.readFile(path.join(f.root, "worker-hook.mjs"), "utf8");
  await fs.writeFile(path.join(f.root, "worker-hook.mjs"), hookText.replace("claimed=false", "claimed=true"));
  const second = await f.run(); assert.equal(second.code, 0, second.output);
  assert.equal(second.requests.filter(item => item.route === "result").length, 1);
});
test("actual personal permission binds complete native args, action hash and original approval expiry", async t => {
  const f = await fixture(t, "permission-allow"), result = await f.run(); assert.equal(result.code, 0, result.output);
  assert.equal(await fs.readFile(f.effect, "utf8"), "allowed");
  const registered = result.requests.find(item => item.route === "approval" && item.body.request).body.request;
  const polled = result.requests.find(item => item.route === "approval" && item.body.requestId).body;
  assert.match(registered.actionHash, /^[a-f0-9]{64}$/); assert.equal(polled.actionHash, registered.actionHash); assert.equal(polled.expiresAt, registered.expiresAt);
  const full = JSON.parse(registered.detail); assert.deepEqual(full.payload.params.env, { SAFE_FLAG: "1" }); assert.equal(full.payload.params.command, "echo safe");
});
for (const mode of ["permission-mismatch", "permission-replay"]) test(`actual ${mode} permission has no action effects or retry`, async t => {
  const f = await fixture(t, mode), result = await f.run(); assert.equal(result.code, 1, result.output);
  await assert.rejects(fs.stat(f.effect)); assert.equal(result.requests.filter(item => item.route === "approval" && item.body.requestId).length, 1);
});
test("actual sensitive permission is denied locally before event or approval upload", async t => {
  const f = await fixture(t, "permission-secret"), result = await f.run(); assert.equal(result.code, 0, result.output);
  assert.ok(!result.requests.some(item => item.route === "approval")); await assert.rejects(fs.stat(f.effect));
  assert.ok(!JSON.stringify(result.requests).includes("FAKE_PERSONAL_REFRESH"));
});
test("actual personal event413 stops execution instead of retrying the CLI", async t => {
  const f = await fixture(t, "events-413"), result = await f.run(); assert.equal(result.code, 1, result.output);
  assert.equal(result.requests.filter(item => item.route === "claim").length, 1);
  assert.equal(result.requests.filter(item => item.route === "result").length, 1);
  assert.equal(result.requests.find(item => item.route === "result").body.result.status, "error");
});
for (const mode of ["result-413", "result-413-always"]) test(`actual personal ${mode} sends one explicit failure receipt with no CLI relaunch`, async t => {
  const f = await fixture(t, mode), result = await f.run(); assert.equal(result.code, 1, result.output);
  const sent = result.requests.filter(item => item.route === "result"); assert.equal(sent.length, 2);
  assert.equal(sent[1].body.result.status, "error"); assert.deepEqual(sent[1].body.result.files, []); assert.equal(sent[1].body.result.diff, "");
  assert.match(sent[1].body.result.summary, /No files or diff were uploaded/);
  assert.equal(result.requests.filter(item => item.route === "claim").length, 1);
  assert.ok(!result.output.includes("settled fixture_run — completed"));
});
