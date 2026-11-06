import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = pathToFileURL(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/run-employee-ci.mjs")).href;

function check(source: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import assert from 'node:assert/strict'; import {createFixtureAuth,fixtureAuthRequest,fixtureChildEnv,fixtureWorkerVars,signalFixtureGroup,assertFixtureGroupGone,stopOwned} from ${JSON.stringify(fixture)}; ${source}`],
  { env: {}, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
  expect(result.status).toBe(0);
}

describe("isolated employee fixture bootstrap", () => {
  it("mints a fresh setup token and binds it to the Worker and exact signup header without putting it in the body", () => {
    check(`
      const first=createFixtureAuth(),second=createFixtureAuth();
      assert(/^[a-f0-9]{64}$/.test(first.bootstrapToken));
      assert(first.bootstrapToken!==second.bootstrapToken,'Setup tokens must be fresh per fixture.');
      const vars=fixtureWorkerVars('http://localhost:8794',first,{pairing:'fixture-pair',auth:'fixture-auth',signing:'fixture-signing'});
      const request=fixtureAuthRequest(first);
      assert.equal(request.route,'/api/auth/sign-up/email');
      assert(request.headers['x-shiba-bootstrap-token']===vars.BETTER_AUTH_BOOTSTRAP_TOKEN);
      assert(vars.BETTER_AUTH_OWNER_EMAIL===request.body.email);
      assert.deepEqual(Object.keys(request.body).sort(),['email','name','password']);
      assert(!JSON.stringify(request.body).includes(first.bootstrapToken),'Setup token must not enter the auth JSON body.');
      assert.equal(vars.MEMORY_ENABLED,'0');assert.equal(vars.TYPESAFE_API_KEY,'');
    `);
  });

  it("does not resend a setup token on sign-in or copy saved fixture metadata into authentication bodies", () => {
    check(`
      const account={...createFixtureAuth(),created:true,extra:'private fixture metadata'};
      const request=fixtureAuthRequest(account);
      assert.equal(request.route,'/api/auth/sign-in/email');
      assert.deepEqual(request.headers,{});
      assert.deepEqual(Object.keys(request.body).sort(),['email','password']);
    `);
  });

  it("preserves tokenless local-driver signup without weakening server bootstrap checks", () => {
    check(`
      const request=fixtureAuthRequest({name:'Fixture',email:'fixture@example.test',password:'fixture-password'});
      assert.equal(request.route,'/api/auth/sign-up/email');assert.deepEqual(request.headers,{});
      assert.deepEqual(Object.keys(request.body).sort(),['email','name','password']);
    `);
  });

  it("never forwards operator bootstrap or provider credentials into the fixture child environment", () => {
    check(`
      const env=fixtureChildEnv({PATH:'/fixture/bin',BETTER_AUTH_BOOTSTRAP_TOKEN:'operator-setup',INTERNAL_SIGNING_KEY:'operator-signing',AI_GATEWAY_TOKEN:'operator-model',TYPESAFE_API_KEY:'operator-typesafe'},'/fixture/private');
      for(const name of ['BETTER_AUTH_BOOTSTRAP_TOKEN','INTERNAL_SIGNING_KEY','AI_GATEWAY_TOKEN','TYPESAFE_API_KEY'])assert(!Object.hasOwn(env,name),'Operator credentials must not be inherited.');
      assert.equal(env.PATH,'/fixture/bin');assert.equal(env.HOME,'/fixture/private/home');
    `);
  });
});


describe("employee fixture process-group cleanup", () => {
  it("signals the owned group and treats ESRCH as already stopped", () => {
    check(`
      let calls=0;
      assert.equal(signalFixtureGroup(123,'SIGTERM',{kill:(pid,signal)=>{assert.equal(pid,-123);assert.equal(signal,'SIGTERM');calls++;}}),true);
      assert.equal(calls,1);
      assert.equal(signalFixtureGroup(123,0,{kill:()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});}}),false);
      assert.throws(()=>signalFixtureGroup(0,'SIGTERM'));
    `);
  });

  it("confirms Darwin EPERM groups have no live members for termination and liveness probes", () => {
    check(`
      const denied=Object.assign(new Error('kill EPERM'),{code:'EPERM'});
      for(const signal of ['SIGTERM',0,'SIGKILL']){
        for(const processes of ['123 Z\\n456 S','456 S','123 Z+\\n123 Z']){
          assert.equal(signalFixtureGroup(123,signal,{platform:'darwin',kill:()=>{throw denied;},listProcesses:()=>processes}),false);
        }
      }
    `);
  });

  it("never hides permission failures for a live descendant, even with a zombie leader", () => {
    check(`
      const denied=Object.assign(new Error('kill EPERM'),{code:'EPERM'});
      for(const processes of ['123 S','123 Z\\n123 R+']){
        assert.throws(()=>signalFixtureGroup(123,0,{platform:'darwin',kill:()=>{throw denied;},listProcesses:()=>processes}),error=>error===denied);
      }
      for(const platform of ['linux','darwin']){
        const code=platform==='linux'?'EPERM':'EINVAL';
        const failure=Object.assign(new Error(code),{code});
        assert.throws(()=>signalFixtureGroup(123,'SIGTERM',{platform,kill:()=>{throw failure;},listProcesses:()=>{throw new Error('must not inspect');}}),error=>error===failure);
      }
    `);
  });

  it("fails closed if process-state inspection fails or cannot be parsed", () => {
    check(`
      const kill=()=>{throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});};
      for(const processes of ['','unexpected output','123']){
        assert.throws(()=>signalFixtureGroup(123,'SIGTERM',{platform:'darwin',kill,listProcesses:()=>processes}));
      }
      assert.throws(()=>signalFixtureGroup(123,'SIGTERM',{platform:'darwin',kill,listProcesses:()=>{throw new Error('ps failed');}}),/ps failed/);
    `);
  });

  it("never signals a known-exited leader's live or unverified group", () => {
    check(`
      let calls=0; const kill=()=>{calls++;};
      for(const signal of ['SIGTERM','SIGKILL']){
        for(const processes of ['123 S','123 Z\\n123 R+'])
          assert.throws(()=>signalFixtureGroup(123,signal,{leaderExited:true,ownGroup:999,kill,listProcesses:()=>processes}),/live or unverified/);
        for(const processes of ['123 Z\\n456 S','456 S'])
          assert.equal(signalFixtureGroup(123,signal,{leaderExited:true,ownGroup:999,kill,listProcesses:()=>processes}),false);
      }
      assert.equal(calls,0);
    `);
  });

  it("derives the exited-leader fence from close, exit code and signal code", () => {
    check(`
      for(const change of [{closed:true},{exitCode:0},{signalCode:'SIGTERM'}]){
        let calls=0;
        const child={pid:123,exitCode:null,signalCode:null,...change};
        const entry={child,closed:change.closed===true,done:Promise.resolve()};
        await assert.rejects(stopOwned(entry,{signalGroup:(pid,signal,options)=>signalFixtureGroup(pid,signal,{
          ...options,ownGroup:999,kill:()=>{calls++;},listProcesses:()=>'123 S',
        })}),/live or unverified/);
        assert.equal(calls,0);assert.notEqual(entry.stopped,true);
      }
    `);
  });

  it("fails after a forced shutdown if a live member or uncertain process list remains", () => {
    check(`
      assert.throws(()=>assertFixtureGroupGone(123,{ownGroup:999,listProcesses:()=>'123 S'}),/live or unverified/);
      assert.throws(()=>assertFixtureGroupGone(123,{ownGroup:999,listProcesses:()=>''}),/empty process list/);
      assert.throws(()=>assertFixtureGroupGone(123,{ownGroup:999,listProcesses:()=>'bad metadata'}),/parse/);
      assert.throws(()=>assertFixtureGroupGone(123,{ownGroup:999,listProcesses:()=>{throw Object.assign(new Error('ps timeout'),{code:'ETIMEDOUT'});}}),/ps timeout/);
      assert.doesNotThrow(()=>assertFixtureGroupGone(123,{ownGroup:999,listProcesses:()=>'123 Z\\n456 S'}));
    `);
  });

  it("does not mark cleanup complete when a member survives the bounded KILL wait", () => {
    check(`
      let clock=0;const signals=[];
      const entry={child:{pid:123,exitCode:null,signalCode:null},closed:false,done:new Promise(()=>{})};
      await assert.rejects(stopOwned(entry,{
        now:()=>clock,wait:async ms=>{clock+=ms;},
        signalGroup:(_pid,signal)=>{signals.push(signal);return true;},
        confirmGone:pid=>assertFixtureGroupGone(pid,{ownGroup:999,listProcesses:()=>'123 S'}),
      }),/live or unverified/);
      assert.equal(signals[0],'SIGTERM');assert.equal(signals.at(-1),'SIGKILL');
      assert(clock>=5000);assert.notEqual(entry.stopped,true);
    `);
  });

  it("rejects reserved and runner process groups before any signal", () => {
    check(`
      let calls=0;const kill=()=>{calls++;};
      assert.throws(()=>signalFixtureGroup(1,'SIGTERM',{ownGroup:999,kill}));
      assert.throws(()=>signalFixtureGroup(123,'SIGTERM',{ownGroup:123,kill}));
      assert.throws(()=>assertFixtureGroupGone(123,{ownGroup:123,listProcesses:()=>'456 S'}));
      assert.equal(calls,0);
    `);
  });
});
