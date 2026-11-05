#!/usr/bin/env node
/**
 * Fresh-state Marketing journey for CI, after pnpm build and browser installation.
 * node .cursor/skills/verify-shiba/scripts/run-employee-ci.mjs
 * VERIFY_DESKTOP=1 selects Electron; VERIFY_EMPLOYEE_PORT overrides localhost:8794.
 * Retain the private fixture directory for diagnosis. Upload only worker.log,
 * migrate.log and result.json, plus the driver's ui-employee-{web,desktop} evidence.
 * No live model, provider credentials, publication or external marketing action.
 */
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {access, chmod, mkdir, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

const ROOT=fileURLToPath(new URL('../../../../',import.meta.url));

export function fixturePort(value='8794'){
  assert(/^\d+$/.test(value),'VERIFY_EMPLOYEE_PORT must be an integer TCP port.');
  const port=Number(value);
  assert(Number.isSafeInteger(port)&&port>=1024&&port<=65535,'VERIFY_EMPLOYEE_PORT must be between 1024 and 65535.');
  return port;
}

/** Explicit allowlist: never forward provider, Git, Access or Cloudflare credentials. */
export function fixtureChildEnv(parent,fixture){
  const env={};
  for(const name of ['PATH','LANG','LC_ALL','TZ','DISPLAY','XAUTHORITY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','PLAYWRIGHT_BROWSERS_PATH','VERIFY_BROWSER_EXECUTABLE_PATH','ELECTRON_OVERRIDE_DIST_PATH','PNPM_HOME','COREPACK_HOME']){
    if(parent[name]!==undefined)env[name]=parent[name];
  }
  return {...env,HOME:path.join(fixture,'home'),TMPDIR:path.join(fixture,'tmp'),
    PLAYWRIGHT_BROWSERS_PATH:parent.PLAYWRIGHT_BROWSERS_PATH??path.join(process.platform==='darwin'?path.join(parent.HOME??os.homedir(),'Library','Caches'):parent.XDG_CACHE_HOME??path.join(parent.HOME??os.homedir(),'.cache'),'ms-playwright'),
    XDG_CONFIG_HOME:path.join(fixture,'home','.config'),XDG_CACHE_HOME:path.join(fixture,'home','.cache'),XDG_DATA_HOME:path.join(fixture,'home','.local','share'),
    CI:'1',NO_COLOR:'1',FORCE_COLOR:'0',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'true',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',
    GIT_CONFIG_NOSYSTEM:'1'};
}

export function createFixtureAuth(){
  return {name:'Employee CI fixture operator',email:`employee-fixture-${randomBytes(12).toString('hex')}@example.test`,
    password:randomBytes(32).toString('base64url'),bootstrapToken:randomBytes(32).toString('hex')};
}

/** Use the real bootstrap header only for the disposable account's first sign-up. */
export function fixtureAuthRequest(auth){
  const created=auth.created===true;
  return {route:`/api/auth/${created?'sign-in':'sign-up'}/email`,
    body:{email:auth.email,password:auth.password,...(!created?{name:auth.name}:{})},
    headers:!created&&auth.bootstrapToken?{'x-shiba-bootstrap-token':auth.bootstrapToken}:{}};
}

export function fixtureWorkerVars(origin,auth,keys){
  return {SHIBA_LOCAL_RUNTIME:'1',BETTER_AUTH_URL:origin,BETTER_AUTH_OWNER_EMAIL:auth.email,
    BETTER_AUTH_BOOTSTRAP_TOKEN:auth.bootstrapToken,PAIRING_SECRET:keys.pairing,
    BETTER_AUTH_SECRET:keys.auth,INTERNAL_SIGNING_KEY:keys.signing,MEMORY_ENABLED:'0',TYPESAFE_API_KEY:''};
}

export function signalFixtureGroup(pgid,signal,{kill=process.kill,platform=process.platform,listProcesses=()=>execFileSync('ps',['-A','-o','pgid=,stat='],{encoding:'utf8'})}={}){
  assert(Number.isSafeInteger(pgid)&&pgid>0,'Fixture process group must be a positive integer.');
  try{kill(-pgid,signal);return true;}catch(error){
    if(error.code==='ESRCH')return false;
    if(error.code!=='EPERM'||platform!=='darwin')throw error;
    // Darwin can return EPERM for a zombie-only group; live members still fail cleanup.
    const rows=listProcesses().trim().split('\n').filter(Boolean);
    assert(rows.length>0,'Cannot confirm fixture process-group exit from an empty process list.');
    for(const row of rows){
      const match=row.trim().match(/^(\d+)\s+(\S+)$/);
      assert(match,'Cannot parse fixture process-group state.');
      if(Number(match[1])===pgid&&!match[2].startsWith('Z'))throw error;
    }
    return false;
  }
}

async function assertFreePort(port){
  // Check both localhost address families without terminating any existing process.
  for(const host of ['127.0.0.1','::1']){
    const server=net.createServer();
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host,port,exclusive:true},resolve);});
    }catch(error){
      if(host==='::1'&&['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code))continue;
      throw new Error(`Employee fixture requires a free localhost:${port} port (${error.code??error.message}).`);
    }finally{
      if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  }
}

/** Redact fixture signing values even if a child unexpectedly prints its environment. */
function attachLog(stream,destination,secrets,echo=false){
  const decoder=new StringDecoder('utf8');let pending='';
  const output=line=>{for(const secret of secrets)line=line.replaceAll(secret,'[redacted fixture secret]');destination.write(line);if(echo)process.stdout.write(line);};
  stream.on('data',chunk=>{pending+=decoder.write(chunk);const lines=pending.split('\n');pending=lines.pop();for(const line of lines)output(line+'\n');});
  stream.on('end',()=>{pending+=decoder.end();if(pending)output(pending);});
}

export async function main(){
  assert(['linux','darwin'].includes(process.platform),'Employee CI runner supports Linux and macOS.');
  const port=fixturePort(process.env.VERIFY_EMPLOYEE_PORT);
  await assertFreePort(port);
  await access(path.join(ROOT,'app-public','app','index.html'));
  if(process.env.VERIFY_DESKTOP==='1')await access(path.join(ROOT,'apps','desktop','dist','main.js'));
  process.umask(0o077);
  await mkdir(path.join(ROOT,'.verify'),{recursive:true});
  const fixture=await mkdtemp(path.join(ROOT,'.verify','employee-ci-'));await chmod(fixture,0o700);
  const origin=`http://localhost:${port}`;
  const desktop=process.env.VERIFY_DESKTOP==='1';
  const evidenceFile=path.join(ROOT,'.verify','local-daemon-e2e',`ui-employee-${desktop?'desktop':'web'}`,'evidence.json');
  const resultFile=path.join(fixture,'result.json');
  let result={passed:false,status:'RUNNING',startedAt:new Date().toISOString(),fixtureOnly:true,freshState:true,liveInference:false,externalMarketingActions:false,target:desktop?'desktop':'web',worker:origin,fixtureDir:fixture,workerLog:path.join(fixture,'worker.log'),migrationLog:path.join(fixture,'migrate.log'),evidenceFile};
  const save=async()=>writeFile(resultFile,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  await save();
  console.log(`Employee CI fixture: ${fixture}\nJourney evidence: ${evidenceFile}`);
  const shutdown=new AbortController();
  const onSignal=signal=>shutdown.abort(new Error(`Employee CI interrupted by ${signal}.`));
  const onTerm=()=>onSignal('SIGTERM');const onInt=()=>onSignal('SIGINT');
  process.once('SIGTERM',onTerm);process.once('SIGINT',onInt);
  const children=[];const logs=[];
  const secrets=['PAIRING_SECRET','BETTER_AUTH_SECRET','INTERNAL_SIGNING_KEY'].map(()=>randomBytes(32).toString('hex'));
  const env=fixtureChildEnv(process.env,fixture);
  function owned(cmd,args,logFile,options={}){
    const log=createWriteStream(logFile,{flags:'a',mode:0o600});logs.push(log);
    const child=spawn(cmd,args,{cwd:ROOT,env,detached:true,stdio:['ignore','pipe','pipe'],...options});
    const entry={child,closed:false};children.push(entry);
    entry.done=new Promise(resolve=>{
      child.once('error',error=>{entry.closed=true;resolve({code:null,error});});
      child.once('close',(code,signal)=>{entry.closed=true;resolve({code,signal});});
    });
    attachLog(child.stdout,log,secrets,options.echo??false);attachLog(child.stderr,log,secrets,options.echo??false);
    return entry;
  }
  async function checked(entry,label,timeoutMs){
    let timer;
    const timedOut=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded ${timeoutMs}ms; inspect ${fixture}.`)),timeoutMs);});
    const interrupted=new Promise((_,reject)=>{if(shutdown.signal.aborted)reject(shutdown.signal.reason);else shutdown.signal.addEventListener('abort',()=>reject(shutdown.signal.reason),{once:true});});
    try{
      const outcome=await Promise.race([entry.done,timedOut,interrupted]);
      if(outcome.error)throw outcome.error;
      assert.equal(outcome.code,0,`${label} failed (${outcome.signal??outcome.code}); inspect ${fixture}.`);
      await stopOwned(entry);
    }finally{clearTimeout(timer);}
  }
  async function stopOwned(entry){
    if(entry.stopped||!entry.child.pid)return;
    const signalGroup=signal=>signalFixtureGroup(entry.child.pid,signal);
    // Signal the owned group even after its leader exits: descendants may remain.
    if(!signalGroup('SIGTERM')){entry.stopped=true;return;}
    const deadline=Date.now()+4000;
    while(Date.now()<deadline){
      if(!signalGroup(0)){entry.stopped=true;return;}
      await delay(100);
    }
    signalGroup('SIGKILL');
    await Promise.race([entry.done,delay(1000)]);
    entry.stopped=true;
  }
  try{
    await Promise.all([mkdir(env.HOME,{recursive:true}),mkdir(env.TMPDIR,{recursive:true}),mkdir(path.join(fixture,'state'))]);
    // Use the supported first-owner bootstrap policy, with exactly one disposable identity.
    const fixtureAuth=createFixtureAuth();
    secrets.push(fixtureAuth.email,fixtureAuth.password,fixtureAuth.bootstrapToken);
    await writeFile(path.join(fixture,'auth.json'),JSON.stringify(fixtureAuth)+'\n',{mode:0o600});
    const envFile=path.join(fixture,'worker.env');
    const workerVars=fixtureWorkerVars(origin,fixtureAuth,{pairing:secrets[0],auth:secrets[1],signing:secrets[2]});
    await writeFile(envFile,Object.entries(workerVars).map(([name,value])=>`${name}=${value}`).join('\n')+'\n',{mode:0o600});
    const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
    const expectedPnpm=pkg.packageManager.match(/^pnpm@([^+]+)/)?.[1];assert(expectedPnpm,'Repository must pin pnpm.');
    const version=owned('pnpm',['--version'],result.migrationLog);
    let versionText='';version.child.stdout.on('data',chunk=>versionText+=chunk);
    await checked(version,'Pinned pnpm check',30000);
    assert.equal(versionText.trim(),expectedPnpm,'Use the repository-pinned pnpm version.');
    result={...result,pnpmVersion:versionText.trim(),phase:'migrate'};await save();
    await checked(owned('pnpm',['exec','wrangler','d1','migrations','apply','shiba-audit','--local','--config',path.join(ROOT,'apps/backend/wrangler.jsonc'),'--persist-to',path.join(fixture,'state'),'--env-file',envFile],result.migrationLog),'Local D1 migration',90000);
    result={...result,phase:'worker-readiness'};await save();
    const worker=owned('pnpm',['exec','wrangler','dev','--config',path.join(ROOT,'apps/backend/wrangler.jsonc'),'--local','--enable-containers=false','--ip','127.0.0.1','--port',String(port),'--env-file',envFile,'--persist-to',path.join(fixture,'state')],result.workerLog);
    const deadline=Date.now()+90000;let readiness;
    while(Date.now()<deadline){
      shutdown.signal.throwIfAborted();assert(!worker.closed,'Local Worker exited before readiness; inspect worker.log.');
      try{
        const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(2000)]);
        const [app,auth]=await Promise.all([fetch(origin+'/app/',{signal}),fetch(origin+'/api/sessions',{signal})]);
        const [html,denied]=await Promise.all([app.text(),auth.json()]);
        if(app.status===200&&app.headers.get('content-type')?.includes('text/html')&&/<html\b/i.test(html)&&/<script\b/i.test(html)&&auth.status===401&&denied.code==='better_auth'){
          readiness={appStatus:app.status,unauthenticatedSessionsStatus:auth.status,authCode:denied.code};break;
        }
      }catch(error){if(shutdown.signal.aborted)throw error;}
      await delay(500,undefined,{signal:shutdown.signal});
    }
    assert(readiness,'Local Worker failed functional dashboard/auth readiness within 90s; inspect worker.log.');
    result={...result,phase:'marketing-journey',readiness};await save();
    const driverStarted=Date.now();
    const driver=owned(process.execPath,[path.join(ROOT,'.cursor/skills/verify-shiba/scripts/drive-local-runtime.mjs')],result.workerLog,{echo:true,env:{...env,VERIFY_LOCAL_WORKER_URL:origin,VERIFY_LOCAL_AUTH_FILE:path.join(fixture,'auth.json'),VERIFY_EMPLOYEE_ROLE:'marketing',VERIFY_EMPLOYEE_MISSING_DELIVERABLE:'1',...(desktop?{VERIFY_DESKTOP:'1'}:{})}});
    await checked(driver,'Marketing UI/native daemon journey',300000);
    assert(!worker.closed,'Local Worker exited during the Marketing journey.');
    const evidenceStat=await stat(evidenceFile);
    assert(evidenceStat.mtimeMs>=driverStarted,'Journey evidence must belong to this invocation.');
    const evidence=JSON.parse(await readFile(evidenceFile,'utf8'));
    assert.equal(evidence.passed,true);assert.equal(evidence.worker,origin);assert.equal(evidence.target,desktop?'desktop':'web');
    assert.equal(evidence.employeeRole,'marketing');assert.equal(evidence.modelBoundary.liveInference,false);assert(evidence.missingDeliverableRunId,'Required-file failure gate must run.');
    assert(evidence.root.startsWith(env.TMPDIR+path.sep),'Journey must use this fresh private fixture directory.');
    result={...result,passed:true,status:'PASS',phase:'complete',uiChecks:evidence.uiSteps.length,protocolChecks:evidence.checks.length,runId:evidence.runId,missingDeliverableRunId:evidence.missingDeliverableRunId,cancelRunId:evidence.cancelRunId};
  }catch(error){
    result={...result,passed:false,status:'FAIL',error:error instanceof Error?error.message:String(error)};
    process.exitCode=1;
  }finally{
    for(const entry of children.reverse())try{await stopOwned(entry);}catch(error){result={...result,passed:false,status:'FAIL',cleanupError:error.message};process.exitCode=1;}
    for(const log of logs)await new Promise(resolve=>log.end(resolve));
    // Ensure a raw fixture signing key never appears in the selectively uploaded logs.
    for(const file of [result.workerLog,result.migrationLog]){
      const text=await readFile(file,'utf8').catch(()=>'');
      if(secrets.some(secret=>text.includes(secret))){
        let sanitized=text;for(const secret of secrets)sanitized=sanitized.replaceAll(secret,'[redacted fixture secret]');
        await writeFile(file,sanitized,{mode:0o600});result={...result,passed:false,status:'FAIL',cleanupError:'Fixture log redaction required a final pass.'};process.exitCode=1;
      }
    }
    result={...result,finishedAt:new Date().toISOString()};await save();
    process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);
    console.log(`${result.status}: ${resultFile}`);
  }
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
