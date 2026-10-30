#!/usr/bin/env node
/**
 * Real local Worker + laptop-daemon protocol acceptance fixture.
 * Start an isolated Worker with SHIBA_LOCAL_RUNTIME=1, PAIRING_SECRET and
 * BETTER_AUTH_SECRET configured; use an absolute --env-file and isolated
 * --persist-to path. Defaults to localhost:8794; VERIFY_LOCAL_WORKER_URL
 * overrides only to another loopback Worker. The fixture creates only a
 * disposable local dashboard account and native Git repository. Only the
 * Claude model CLI is replaced; pairing, approvals, claim, Git, diff,
 * persistence and cancellation use the real implementation.
 * No inference, messages, PR publishing, or native macOS execution is claimed.
 */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
// Reuse the repository's existing Playwright Core dependency from the desktop
// workspace. The fixture supplies its own installed Chromium executable, so
// it does not need Playwright's browser-download package.
const desktopRequire=createRequire(new URL('../../../../apps/desktop/package.json',import.meta.url));
const {chromium}=desktopRequire('playwright-core');
import {launchLifecycleTarget} from './lifecycle-target.mjs';
const exec=promisify(execFile);
const origin=process.env.VERIFY_LOCAL_WORKER_URL??'http://localhost:8794';
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname),'This disposable-account fixture may run only against a local Worker.');
const employeeRole=process.env.VERIFY_EMPLOYEE_ROLE;
assert(employeeRole===undefined||employeeRole==='marketing','VERIFY_EMPLOYEE_ROLE supports only marketing.');
const marketing=employeeRole==='marketing';
const checkMissingDeliverable=process.env.VERIFY_EMPLOYEE_MISSING_DELIVERABLE==='1';
assert(!checkMissingDeliverable||marketing,'Missing-deliverable fixture requires VERIFY_EMPLOYEE_ROLE=marketing.');
const artifactDir='.verify/local-daemon-e2e/ui-'+(marketing?'employee-':'')+(process.env.VERIFY_DESKTOP==='1'?'desktop':'web');
const marketingFiles=[
  {path:'marketing/brief.md',content:'# Marketing brief — fixture draft\n\nAudience: maintainers of this disposable local fixture.\nObjective: verify retained deliverables, not campaign performance.\nSource: README.md in the approved fixture repository.\nEvidence: deterministic fixture CLI wrote this file after human tool approval.\nUnsupported claims: no customer, pricing, conversion, or market claims were researched.\n'},
  {path:'marketing/campaign.md',content:'# Campaign draft — fixture only\n\nDraft copy: Review the two captured files in this local acceptance fixture.\nCall to action: inspect the brief and verify the recorded checksums.\nReview checklist: confirm sources, names, and product claims before any publication.\nNo external post, message, inference, or campaign action was performed.\n'},
];
mkdirSync(artifactDir,{recursive:true});
let currentEvidence={passed:false,status:'RUNNING',modelBoundary:{cli:'deterministic fixture Claude CLI',liveInference:false},...(marketing?{employeeRole,externalMarketingActions:false}:{}),worker:origin,startedAt:new Date().toISOString()};
const persistEvidence=record=>{currentEvidence=record;writeFileSync(artifactDir+'/evidence.json',JSON.stringify(record,null,2)+'\n');};
persistEvidence(currentEvidence);
process.once('uncaughtExceptionMonitor',error=>{try{persistEvidence({...currentEvidence,passed:false,status:'FAIL',failedAt:new Date().toISOString(),error:error instanceof Error?error.message:String(error)});}catch{}});

await mkdir('.verify/local-daemon-e2e',{recursive:true});
const root=await mkdtemp(path.join(os.tmpdir(),'shiba-real-local-'));
const source=path.join(root,'fixture'); const operatorProfile=path.join(root,'operator-profile'); const bin=path.join(root,'bin'); const daemonRoot=path.join(root,'daemon');
await Promise.all([mkdir(source),mkdir(operatorProfile),mkdir(bin)]);
await exec('git',['init','-b','main',source]); await writeFile(path.join(source,'README.md'),'before local run\n'); await exec('git',['-C',source,'add','.']); await exec('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.com','commit','-m','fixture']);
const repoUrl='https://github.com/shiba-local-fixture/repo';
await writeFile(path.join(operatorProfile,'.gitconfig'),`[url "${source}"]\n\tinsteadOf = ${repoUrl}\n`);
await writeFile(path.join(bin,'claude'),`#!${process.execPath}\nimport {createInterface} from 'node:readline'; import {writeFileSync,mkdirSync} from 'node:fs'; import path from 'node:path'; import {spawn as spawnTool} from 'node:child_process';
const marketingFiles=${JSON.stringify(marketing?marketingFiles:[])};
if(process.argv.includes('--version')){console.log('fixture-claude'); process.exit(0)}
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let prompt=''; process.on('SIGTERM',()=>{writeFileSync('.git/fake-cli-cancelled','terminated');process.exit(0)});
send({type:'system',subtype:'init',session_id:'local-fixture'});
createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.type==='user'){
prompt=m.message.content.map(x=>x.text??'').join('');writeFileSync('.git/fake-cli-proof.json',JSON.stringify({prompt,argv:process.argv,controlTokenPresent:!!process.env.LOCAL_ADAPTER_TOKEN}));
send({type:'assistant',message:{content:[{type:'text',text:'fixture CLI reached'}]}});
if(prompt.includes('CANCEL_FIXTURE')){const tool=spawnTool(process.execPath,['-e','setInterval(()=>require("node:fs").appendFileSync(".git/tool-sentinel","x"),40)'],{stdio:'ignore'});writeFileSync('.git/tool-pid',String(tool.pid));return;}
send({type:'control_request',request_id:'write-fixture',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:marketingFiles[0]?.path??'README.md',content:marketingFiles[0]?.content??'after approved local run'}}});
}else if(m.type==='control_response'){
if(m.response?.response?.behavior==='allow'){writeFileSync('README.md','after approved local run\\n');for(const file of marketingFiles){if(prompt.includes('OMIT_DELIVERABLE_FIXTURE')&&file.path==='marketing/campaign.md')continue;mkdirSync(path.dirname(file.path),{recursive:true});writeFileSync(file.path,file.content);}send({type:'result',result:'fixture edit complete',session_id:'local-fixture'});}else send({type:'result',is_error:true,result:'permission denied',session_id:'local-fixture'});
}});\n`,{mode:0o755});
let cookie='';
async function api(route,body,method=body===undefined?'GET':'POST') {const res=await fetch(origin+route,{method,headers:{'content-type':'application/json',origin,...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}); const raw=await res.text();let data;try{data=JSON.parse(raw)}catch{data=raw}; if(!res.ok)throw Error(route+' '+res.status+' '+JSON.stringify(data).slice(0,500));return {res,data};}
async function poll(fn,label,ms=45000){const until=Date.now()+ms;while(Date.now()<until){const out=await fn();if(out)return out;await new Promise(r=>setTimeout(r,250))}throw Error('Timeout: '+label)}
const authFile=process.env.VERIFY_LOCAL_AUTH_FILE??'.verify/local-daemon-e2e/auth.json';let auth;try{auth=JSON.parse(await readFile(authFile,'utf8'))}catch{};if(!auth){auth={name:'Local fixture operator',email:'local-fixture-'+Date.now()+'@example.test',password:'Fixture-only-password-'+Date.now()};await writeFile(authFile,JSON.stringify(auth),{mode:0o600});}const signup=await api('/api/auth/'+(auth.created?'sign-in':'sign-up')+'/email',auth);auth.created=true;await writeFile(authFile,JSON.stringify(auth),{mode:0o600});
cookie=signup.res.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert(cookie);
const pairing=(await api('/api/computers/pairing-token',{})).data;
const daemonEnv={...process.env,HOME:operatorProfile,PATH:bin+path.delimiter+process.env.PATH,SHIBA_LOCAL_RUN_ROOT:daemonRoot};delete daemonEnv.LOCAL_ADAPTER_TOKEN;delete daemonEnv.SHIBA_WORKER_URL;
const daemon=spawn(process.execPath,['scripts/shiba-local-daemon.mjs','--connect',origin,'--pair',pairing.token,'--poll','500'],{cwd:process.cwd(),env:daemonEnv,stdio:['ignore','pipe','pipe']});
// Pairing credentials stay in this disposable operator profile, never artifacts.
let output='';daemon.stdout.on('data',v=>output+=v);daemon.stderr.on('data',v=>output+=v);
let machine;let target;let page;const uiSteps=[];

const passed=step=>{uiSteps.push(step);console.log('PASS '+step)};
try{
machine=await poll(async()=>{const list=(await api('/api/computers')).data.computers;const paired=JSON.parse(await readFile(path.join(daemonRoot,'config.json'),'utf8').catch(()=>'{"machineId":null}'));return list?.find(x=>x.machineId===paired.machineId&&x.harnesses?.includes('claude'))},'paired machine heartbeat');
const stamp=Date.now();
const config={name:(marketing?'Marketing fixture bot ':'Local fixture bot ')+stamp,instructions:'FROZEN_LOCAL_PROFILE_V1',harness:'claude-code',codingModel:'anthropic/claude-sonnet-5-5',defaultRepoUrl:repoUrl};
target=await launchLifecycleTarget(new URL(origin),chromium);page=target.page;page.setDefaultTimeout(30000);
const browserCookies=signup.res.headers.getSetCookie().map(raw=>{const pair=raw.split(';')[0];const split=pair.indexOf('=');return {name:pair.slice(0,split),value:pair.slice(split+1),url:origin,httpOnly:true,sameSite:'Lax'};});
await target.context.addCookies(browserCookies);
await page.goto(origin+'/app/?tab=integrations');
const initialSetupClose=page.getByRole('button',{name:'Close setup',exact:true});await initialSetupClose.waitFor({timeout:10000}).catch(()=>{});if(await initialSetupClose.isVisible())await initialSetupClose.click();
await page.getByRole('heading',{name:'Integrations',exact:true}).waitFor();
await page.getByRole('button',{name:'Browse capability catalog',exact:true}).click();
const catalog=await api('/api/capabilities?limit=50');
assert(catalog.res.ok,'Authenticated capability directory returns '+catalog.res.status);
assert(catalog.data.entries.length>0,'Built-in MCP tools come from the backend registry');
assert(catalog.data.entries.every(entry=>entry.allowed===false&&!Object.hasOwn(entry,'inputSchema')),'Dashboard directory is metadata-only, with no permission grant or schemas');
await page.getByRole('button',{name:/gmail_search/}).click();
await page.getByText('gmail:read',{exact:true}).first().waitFor();
await page.getByText(/This is a catalog entry, not an assigned permission/).waitFor();
assert.equal(await page.getByRole('button',{name:'Reconnect',exact:true}).count(),0,'MCP catalog rows cannot trigger fake reconnects');
await page.getByRole('searchbox',{name:'Search capabilities'}).fill('gmail_search');
await page.getByRole('button',{name:/gmail_search/}).waitFor();
await page.getByRole('combobox',{name:'Filter by type'}).selectOption('mcp');
await page.getByRole('combobox',{name:'Filter by status'}).selectOption('available');
await page.screenshot({path:artifactDir+'/capability-catalog.png',fullPage:true});
passed('Browse the authenticated registry-backed catalog, inspect required scope, search/filter MCP tools, and withhold unsupported actions');
await page.goto(origin+'/app/?tab=custom-agents');
const setupClose=page.getByRole('button',{name:'Close setup',exact:true});await setupClose.waitFor({timeout:10000}).catch(()=>{});if(await setupClose.isVisible())await setupClose.click();
await page.getByRole('button',{name:'Create bot',exact:true}).waitFor();
if(marketing){
  await page.getByRole('button',{name:'Marketing',exact:true}).click();
  assert.equal(await page.getByLabel('Name',{exact:true}).inputValue(),'Marketing bot');
  assert.equal(await page.getByLabel('Required deliverables',{exact:true}).inputValue(),marketingFiles.map(file=>file.path).join('\n'));
  const templateInstructions=await page.getByLabel(/^Instructions/).inputValue();
  assert(templateInstructions.includes('You are the marketing bot.'));
  config.instructions=templateInstructions+'\n\n'+config.instructions;
  passed('Marketing role template fills real required deliverables before creation');
}
await page.getByLabel('Slug',{exact:true}).fill('local-ui-fixture-'+stamp);
await page.getByLabel('Name',{exact:true}).fill(config.name);
await page.getByLabel(/^Instructions/).fill(config.instructions);
await page.getByLabel('Harness',{exact:true}).fill(config.harness);
await page.getByLabel('Model',{exact:true}).fill(config.codingModel);
await page.getByRole('combobox',{name:/^Model connection/}).selectOption('');
await page.getByLabel('Default repository',{exact:true}).fill(repoUrl);
const [created]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/custom-agents'&&response.request().method()==='POST'),page.getByRole('button',{name:'Create bot',exact:true}).click()]);assert.equal(created.status(),201,await created.text());const profile=(await created.json()).agent;
assert.equal(profile.config.harness,config.harness);assert.equal(profile.version,1);
if(marketing){
  assert.deepEqual(profile.config.expectedDeliverables,marketingFiles.map(file=>file.path));
  const persisted=(await api('/api/custom-agents/'+encodeURIComponent(profile.id))).data.agent;
  assert.deepEqual(persisted.config.expectedDeliverables,profile.config.expectedDeliverables);
  assert.equal(persisted.config.instructions,config.instructions,'Editing the template must preserve its instructions and required paths');
}
passed('Create bot through the real directory UI');
await page.screenshot({path:artifactDir+'/bot-created.png',fullPage:true});
const [sessionCreated]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sessions'&&response.request().method()==='POST'),page.getByRole('button',{name:'Launch bot '+config.name,exact:true}).click()]);assert.equal(sessionCreated.status(),201,await sessionCreated.text());
const session=(await sessionCreated.json()).session;assert.equal(session.metadata.customAgentId,profile.id);
const sessionQuery='?session='+encodeURIComponent(session.id);
const botLabel='Bot: '+(profile.config.emoji?profile.config.emoji+' ':'')+config.name;
await page.getByText(botLabel,{exact:true}).waitFor();
passed('Launch bot opens a real bound conversation');
async function reopenThread(){
  await page.goto(origin+'/app/?tab=custom-agents');
  await page.getByRole('list',{name:config.name+' threads',exact:true}).getByRole('button').filter({hasText:config.name}).first().click();
  await page.getByText(botLabel,{exact:true}).waitFor();
}
async function queue(task){
  await page.getByLabel('Task description',{exact:true}).fill(task);
  await page.getByRole('button',{name:/^Run on:/}).click();
  await page.getByRole('menuitemradio',{name:/Local \(Paired computer\)/}).click();
  await page.getByRole('button',{name:'Run on: Local',exact:true}).waitFor();
  if(!await page.getByLabel('Local computer',{exact:true}).isVisible())await page.getByRole('button',{name:'Run on: Local',exact:true}).click();
  await page.getByLabel('Local computer',{exact:true}).selectOption(machine.machineId);
  await page.getByRole('button',{name:'Run on: Local',exact:true}).click();
  const [response]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST'),page.getByRole('button',{name:'Send task',exact:true}).click()]);assert(response.ok(),'Task queue status '+response.status());
  const approval=await poll(async()=>{const pending=(await api('/api/approvals')).data;return pending.approvals.find(item=>item.customAgentId===profile.id&&item.task.endsWith(task))},'UI-created pending approval');assert(approval);
  assert.equal(approval.customAgentVersion,1);assert.equal(approval.customAgentId,profile.id);assert.equal(approval.runtime,'local');assert.equal(approval.targetMachineId,machine.machineId);
  assert.equal(approval.threadKey,session.agentName,'Worker derives queue owner from the verified named session');
  if(marketing)assert.deepEqual(approval.expectedDeliverables,marketingFiles.map(file=>file.path),'Approval freezes the role requirements');
  passed('Send task UI queues a frozen local bot approval');
  return approval;
}
async function approveInUi(pointer){
  await page.goto(origin+'/app/?tab=approvals');
  const card=page.locator('div').filter({has:page.getByRole('button',{name:'Approve',exact:true})}).filter({hasText:pointer.task}).last();
  await card.getByText('Bot profile v1',{exact:true}).waitFor();
  if(marketing){
    const frozen=card.getByRole('list',{name:'Frozen required deliverables',exact:true});
    for(const file of marketingFiles)await frozen.getByText(file.path,{exact:true}).waitFor();
  }
  const [response]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/approvals'&&response.request().method()==='POST'),card.getByRole('button',{name:'Approve',exact:true}).click()]);assert(response.ok(),'Approval status '+response.status());
  passed('Human approval uses the real dashboard button');
}
const p=await queue('EDIT_FIXTURE');
assert.equal((await api('/api/runs'+sessionQuery)).data.runs.length,0,'queue must not execute');
await page.screenshot({path:artifactDir+'/task-queued.png',fullPage:true});
await approveInUi(p);
const active=await poll(async()=>{const run=(await api('/api/runs/'+encodeURIComponent('agent-tool:'+p.approvalId)+sessionQuery)).data.run;if(!run?.sandboxId)return false;const rows=(await api('/api/computers/harness')).data.runs;return rows?.find(r=>r.sandboxId===run.sandboxId&&r.approvals?.some(a=>a.requestId==='write-fixture'&&a.decision===undefined))},'this bot daemon tool approval');
const work=path.join(daemonRoot,'runs',active.sandboxId,'work');
assert.equal(await readFile(path.join(work,'README.md'),'utf8'),'before local run\n');
if(marketing)for(const file of marketingFiles)await assert.rejects(readFile(path.join(work,file.path)),{code:'ENOENT'},'Marketing files must not exist before tool approval');
await page.getByRole('region',{name:'Live agent session',exact:true}).filter({has:page.getByText(active.sandboxId,{exact:true})}).getByRole('button',{name:'Allow',exact:true}).click();passed('Allow tool UI releases this bot daemon CLI permission gate');
const completed=await poll(async()=>{const run=(await api('/api/runs/'+encodeURIComponent('agent-tool:'+p.approvalId)+sessionQuery)).data.run; if(run?.status==='error')throw Error('Run error '+JSON.stringify(run));return run?.status==='completed'&&run},'completed persisted diff');
assert.equal(completed.customAgentVersion,1); assert.equal(completed.customAgentId,profile.id);assert(completed.diff.includes('after approved local run'));assert(completed.signals.some(s=>s.kind==='local.claimed'));
const proof=JSON.parse(await readFile(path.join(work,'.git/fake-cli-proof.json'),'utf8'));assert(proof.prompt.includes('FROZEN_LOCAL_PROFILE_V1'));assert.equal(proof.controlTokenPresent,false);assert.equal(proof.argv[proof.argv.indexOf('--permission-mode')+1],'default');
if(marketing){
  assert(proof.prompt.includes('You are the marketing bot.'));
  assert.deepEqual(completed.expectedDeliverables,marketingFiles.map(file=>file.path));
  for(const file of marketingFiles)assert.equal(await readFile(path.join(work,file.path),'utf8'),file.content,'Native daemon workspace contains the approved marketing file');
}
await reopenThread();await page.getByTestId('run-agent-version').filter({hasText:'Bot profile v1'}).first().waitFor();await page.screenshot({path:artifactDir+'/completed-local-bot.png',fullPage:true});passed('Completed bot run and version render in the real conversation UI');
let deliverableEvidence;
if(marketing){
  // Recreate page state before reading retained results: these links must survive a refresh.
  await page.reload();await reopenThread();
  const retained=(await api('/api/runs/'+encodeURIComponent(completed.runId)+sessionQuery)).data.run;
  const listed=(await api('/api/runs'+sessionQuery)).data.runs.find(run=>run.runId===completed.runId);
  assert(listed,'Completed marketing run survives refresh and list projection');
  assert.equal(Object.hasOwn(retained,'resultArtifacts'),false,'Private bodies must not appear on the run detail API');
  assert.equal(Object.hasOwn(listed,'resultArtifacts'),false,'Private bodies must not appear on the run list API');
  const expectedMetadata=marketingFiles.map(file=>({path:file.path,mediaType:'text/markdown; charset=utf-8',bytes:Buffer.byteLength(file.content),sha256:createHash('sha256').update(file.content).digest('hex')}));
  assert.deepEqual(retained.deliverables,expectedMetadata);
  assert.deepEqual(listed.deliverables,expectedMetadata);
  const wrongSession=(await api('/api/sessions',{name:'Marketing fixture access check '+stamp})).data.session;
  assert.notEqual(wrongSession.id,session.id);
  const deliverables=page.getByRole('region',{name:'Deliverables',exact:true}).filter({has:page.getByRole('link',{name:'Download marketing/brief.md',exact:true})});
  await deliverables.waitFor();
  for(const [index,file] of marketingFiles.entries()){
    const link=deliverables.getByRole('link',{name:'Download '+file.path,exact:true});
    const href=await link.getAttribute('href');
    const expectedRoute='/api/runs/'+encodeURIComponent(completed.runId)+'/deliverables/'+index;
    assert.equal(href,expectedRoute+sessionQuery,'Download link retains the owning named session');
    await deliverables.getByText('SHA-256: '+expectedMetadata[index].sha256,{exact:true}).waitFor();
    const response=await fetch(origin+href,{headers:{cookie},signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),expectedMetadata[index].mediaType);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes,Buffer.from(file.content));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expectedMetadata[index].sha256);
    assert.equal(bytes.length,expectedMetadata[index].bytes);
    await mkdir(path.join(artifactDir,'deliverables',path.dirname(file.path)),{recursive:true});
    await writeFile(path.join(artifactDir,'deliverables',file.path),bytes);
    if(target.target==='web'){
      const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
      const downloadPath=path.join(artifactDir,'deliverables','download-'+path.basename(file.path));
      await download.saveAs(downloadPath);assert.deepEqual(await readFile(downloadPath),bytes,'UI download contains the retained bytes');
    }
    for(const query of ['', '?session='+encodeURIComponent(wrongSession.id)]){
      const denied=await fetch(origin+expectedRoute+query,{headers:{cookie},signal:AbortSignal.timeout(10000)});
      assert.equal(denied.status,404,'Missing or other owned session must not expose a deliverable');
      assert(!(await denied.text()).includes(file.content),'Denied response must not expose captured content');
    }
  }
  const absent=await fetch(origin+'/api/runs/'+encodeURIComponent(completed.runId)+'/deliverables/2'+sessionQuery,{headers:{cookie},signal:AbortSignal.timeout(10000)});
  assert.equal(absent.status,404,'An uncaptured deliverable index must not resolve');
  deliverableEvidence={metadata:expectedMetadata,privateBodiesStripped:true,missingAndWrongOwnedSessionStatus:404,refreshed:true,webDownloadsVerified:target.target==='web'};
  await page.screenshot({path:artifactDir+'/completed-marketing-deliverables.png',fullPage:true});
  passed('Marketing deliverables survive refresh with exact native bytes, metadata, hashes and scoped downloads');
}
const [reviewResponse]=await Promise.all([
  page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/threads/'+encodeURIComponent(completed.runId)+'/pr/review'&&response.request().method()==='GET'),
  page.getByRole('navigation',{name:'Main',exact:true}).getByRole('button',{name:'Pull requests',exact:true}).click(),
]);
assert.equal(reviewResponse.status(),200,'Named-session review must resolve the completed run');
assert.equal(new URL(reviewResponse.url()).searchParams.get('session'),session.id,'Review request must retain the owning session');
await page.locator('[data-testid="review-findings"][data-state="loading"]').waitFor({state:'hidden'});
assert.equal(await page.locator('[data-testid="review-findings"][data-state="error"]').count(),0,'Review must settle without an error');
assert.equal(await page.getByText('Review: Run not found',{exact:false}).count(),0);
await page.getByRole('combobox',{name:'Select run for diff inspection',exact:true}).selectOption(completed.runId);
const displayedDiff=page.getByRole('region',{name:'Diff for '+completed.runId,exact:true});
await displayedDiff.getByText('after approved local run',{exact:false}).last().waitFor();
const displayedPatch=await displayedDiff.textContent();
assert.doesNotMatch(displayedPatch,/^SHIBA_AI_COWORKER_CODING_RESULT_JSON\r?$/m,'Displayed patch must exclude the unprefixed protocol marker');
assert.doesNotMatch(displayedPatch,/^\{"status":"completed","exitCode":/m,'Displayed patch must exclude the raw result envelope');
assert.equal(displayedPatch,completed.diff,'Displayed patch must exactly match the authoritative retained Git diff');
if(target.target==='web'){
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'.diff',exact:true}).click()]);
  const patchFile=artifactDir+'/completed-local.diff';await download.saveAs(patchFile);
  assert.equal(await readFile(patchFile,'utf8'),completed.diff,'Exported patch must exactly match the authoritative retained Git diff');
}

await page.screenshot({path:artifactDir+'/completed-local-diff.png',fullPage:true});passed('Real diff UI renders the native Git patch with successful named-session review');await reopenThread();
let missingDeliverableRunId;
if(checkMissingDeliverable){
  const missingPointer=await queue('OMIT_DELIVERABLE_FIXTURE');await approveInUi(missingPointer);
  missingDeliverableRunId='agent-tool:'+missingPointer.approvalId;
  const missingActive=await poll(async()=>{const run=(await api('/api/runs/'+encodeURIComponent(missingDeliverableRunId)+sessionQuery)).data.run;if(!run?.sandboxId)return false;return (await api('/api/computers/harness')).data.runs?.find(row=>row.sandboxId===run.sandboxId&&row.approvals?.some(approval=>approval.requestId==='write-fixture'&&approval.decision===undefined))},'missing deliverable tool approval');
  await page.getByRole('region',{name:'Live agent session',exact:true}).filter({has:page.getByText(missingActive.sandboxId,{exact:true})}).getByRole('button',{name:'Allow',exact:true}).click();
  const failed=await poll(async()=>{const run=(await api('/api/runs/'+encodeURIComponent(missingDeliverableRunId)+sessionQuery)).data.run;assert.notEqual(run?.status,'completed','Missing required file must never produce a completed run');return run?.status==='error'&&run},'missing required marketing file fails closed');
  assert.deepEqual(failed.expectedDeliverables,marketingFiles.map(file=>file.path));
  assert.equal(failed.deliverables?.length??0,0);assert.equal(Object.hasOwn(failed,'resultArtifacts'),false);
  const missingWork=path.join(daemonRoot,'runs',missingActive.sandboxId,'work');
  assert.equal(await readFile(path.join(missingWork,marketingFiles[0].path),'utf8'),marketingFiles[0].content);
  await assert.rejects(readFile(path.join(missingWork,marketingFiles[1].path)),{code:'ENOENT'});
  for(const index of [0,1]){
    const denied=await fetch(origin+'/api/runs/'+encodeURIComponent(missingDeliverableRunId)+'/deliverables/'+index+sessionQuery,{headers:{cookie},signal:AbortSignal.timeout(10000)});
    assert.equal(denied.status,404,'Failed capture must not expose partial deliverables');
  }
  await reopenThread();
  const failedCard=page.locator('[data-testid="run-progress"][data-run-status="error"]').filter({hasText:'OMIT_DELIVERABLE_FIXTURE'});
  await failedCard.waitFor();
  assert.equal(await failedCard.getByRole('link',{name:/^Download /}).count(),0,'Failed run UI must not offer partial downloads');
  assert.equal(await failedCard.getByText('Not captured',{exact:true}).count(),2);
  await page.screenshot({path:artifactDir+'/missing-marketing-deliverable.png',fullPage:true});
  passed('Missing required marketing file yields an error and no downloadable partial result');
}
const cancelledPointer=await queue('CANCEL_FIXTURE');await approveInUi(cancelledPointer);
const cancelRunId='agent-tool:'+cancelledPointer.approvalId;
const running=await poll(async()=>{const r=(await api('/api/runs/'+encodeURIComponent(cancelRunId)+sessionQuery)).data.run;if(!r?.sandboxId)return false;try{await readFile(path.join(daemonRoot,'runs',r.sandboxId,'work','.git/fake-cli-proof.json'));return r}catch{return false}},'cancel fixture CLI starts');
const cancelled=(await api('/api/runs/'+encodeURIComponent(cancelRunId)+sessionQuery,undefined,'DELETE')).data.run; assert.equal(cancelled.status,'cancelled');
await poll(async()=>{try{return await readFile(path.join(daemonRoot,'runs',running.sandboxId,'work','.git/fake-cli-cancelled'),'utf8')}catch{return false}},'cancel reaches actual CLI',10000);
assert.equal((await api('/api/runs/'+encodeURIComponent(cancelRunId)+sessionQuery)).data.run.status,'cancelled');
const sentinel=path.join(daemonRoot,'runs',running.sandboxId,'work','.git/tool-sentinel');const previous=await readFile(sentinel,'utf8');await new Promise(r=>setTimeout(r,300));assert.equal(await readFile(sentinel,'utf8'),previous,'run-owned tool subprocess must stop');
const result={passed:true,status:'PASS',modelBoundary:{cli:'deterministic fixture Claude CLI',liveInference:false},...(marketing?{employeeRole,externalMarketingActions:false,deliverableEvidence,...(missingDeliverableRunId?{missingDeliverableRunId}:{})}:{}),target:target.target,...(target.desktopEvidence?{desktop:target.desktopEvidence}:{}),uiSteps,worker:origin,root,checks:['real Better Auth local identity','one-time daemon pairing','heartbeat and machine discovery','human task approval','native Git fixture clone','real daemon claim','native Claude protocol tool approval','frozen profile version/instructions/permissions','real file edit and persisted diff','dashboard cancellation terminates CLI','cancelled result remains fenced','run-owned CLI tool subprocess stopped',...(marketing?['actual Marketing role UI template and persisted required paths','approved native marketing file writes','refreshed deliverable metadata and exact bytes/hash','private artifact bodies absent from run projections','download requires the owning named session']:[]),...(checkMissingDeliverable?['missing required file fails with no downloadable partial result']:[])],runId:completed.runId,cancelRunId};
persistEvidence(result);console.log(JSON.stringify(result,null,2));
}catch(error){persistEvidence({...currentEvidence,passed:false,status:'FAIL',root,uiSteps,error:error instanceof Error?error.message:String(error)});await page?.screenshot({path:artifactDir+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(artifactDir+'/daemon.log',output);console.error('fixtureRoot',root);throw error}finally{await target?.close().catch(()=>{});daemon.kill('SIGTERM');await Promise.race([new Promise(r=>daemon.once('close',r)),new Promise(r=>setTimeout(r,4000))]);}
