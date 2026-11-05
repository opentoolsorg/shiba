import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SlackInstallationPublic, SlackInstallationState } from "@shiba/shared";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { handleSlackInstallations } from "../src/slack-installations-routes.js";
import { handleMultiInstallationSlackCallback } from "../src/slack-installations-routing.js";
import { activeSlackInstallationForTeam, ensureSlackInstallations, readSlackInstallationCredential, SLACK_INSTALLATION_SCHEMA, slackInstallationGuard, type SlackInstallationEnv } from "../src/slack-installations-store.js";
import { sealSlackSecret, openSlackSecret } from "../src/slack-installations-crypto.js";
import { verifySlackInstallationBot, type SlackOAuthDeps } from "../src/slack-installations-oauth.js";

const identity = vi.hoisted(() => ({ email: "owner@example.test", native: true, accounts: {} as Record<string,string> }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => identity.email }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => identity.native ? { policy: { accountId: identity.accounts[identity.email], email: identity.email, kind: "invited", createdAt: 1 }, emailVerified: true } : null }));
const OWNER = "owner@example.test", OTHER = "other@example.test", TOKEN = "xoxb-fixture-only-not-a-real-token", REFRESH = "xoxe-fixture-only-not-a-real-token";
beforeEach(() => { identity.email=OWNER; identity.native=true; identity.accounts={}; let now=Date.now(); vi.spyOn(Date,"now").mockImplementation(()=>++now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const db = customAgentD1();
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');
  for (const email of [OWNER,OTHER]) { identity.accounts[email]=crypto.randomUUID(); db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(identity.accounts[email]!,email); db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(identity.accounts[email]!,email); }
  const env = { AGENT_AUDIT:db.database, SLACK_INSTALLATIONS_ENABLED:"true", SLACK_OAUTH_APP_ID:"A123", SLACK_OAUTH_CLIENT_ID:"123.456", SLACK_OAUTH_REDIRECT_URI:"https://shiba.test/api/slack/installations/callback",
    SLACK_OAUTH_PKCE_ENABLED:"true", SLACK_OAUTH_QUERY_REDACTION_VERIFIED:"true", SLACK_SIGNING_SECRET:"fixture-signing-secret-only", SLACK_INSTALLATION_KEYRING:JSON.stringify({activeKeyId:"v1",keys:{v1:"11".repeat(32)}}),
    SLACK_BOT_TOKEN:"legacy-fixture-token-must-not-fallback" } as unknown as SlackInstallationEnv;
  const workspace = await createTeamWorkspace(env,OWNER,{name:"Owner workspace"}), other = await createTeamWorkspace(env,OTHER,{name:"Other workspace"});
  await ensureSlackInstallations(env);
  const responseValue = {ok:true,token_type:"bot",access_token:TOKEN,refresh_token:REFRESH,expires_in:3600,app_id:"A123",team:{id:"T123"},enterprise:null,is_enterprise_install:false,bot_user_id:"UB123",authed_user:{id:"UINSTALLER"},scope:"chat:write"};
  const exchange=vi.fn(async (_url:RequestInfo|URL,_init?:RequestInit)=>Response.json(responseValue)), verify=vi.fn(async (_token:string)=>({teamId:"T123",userId:"UB123",botId:"B123"}));
  const deps:SlackOAuthDeps={fetch:exchange,verifyInstallation:verify};
  const call=async(path="",body?:unknown,scope=workspace.workspaceId,custom=deps,headers:Record<string,string>={})=>{
    const response=await handleSlackInstallations(new Request("https://shiba.test/api/slack/installations"+path,{method:body===undefined?"GET":"POST",headers:{Origin:"https://shiba.test","Content-Type":"application/json","X-Shiba-Workspace":scope,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,custom);
    return {response:response!,value:await response!.json() as SlackInstallationState&{authorizationUrl?:string,error?:string}};
  };
  const begin=async(scope=workspace.workspaceId)=>{
    const result=await call("/begin",{requestId:crypto.randomUUID(),scopes:["chat:write"],consent:"install-bot-in-selected-slack-workspace"},scope);
    expect(result.response.status,JSON.stringify(result.value)).toBe(200);return new URL(result.value.authorizationUrl!);
  };
  const callback=async(authorize:URL,custom=deps)=>handleSlackInstallations(new Request(`https://shiba.test/api/slack/installations/callback?state=${authorize.searchParams.get("state")}&code=fixture-code`),env,custom);
  const decision=(row:SlackInstallationPublic)=>({expectedVersion:row.version,digest:row.digest,reviewed:true});
  const install=async()=>{const authorize=await begin(),done=await callback(authorize);expect(done?.status,await done?.clone().text()).toBe(303);const state=await call(),row=state.value.installations[0]!;expect(row.state).toBe("pending");return row;};
  const activate=async()=>{const row=await install(),result=await call(`/${row.id}/activate`,decision(row));expect(result.response.status,JSON.stringify(result.value)).toBe(200);return result.value.installations[0]!;};
  const signed=async(body:unknown,path="/api/slack/events")=>{
    const raw=typeof body==="string"?body:JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000)),key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SLACK_SIGNING_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`v0:${timestamp}:${raw}`))),(byte)=>byte.toString(16).padStart(2,"0")).join("");
    return new Request("https://shiba.test"+path,{method:"POST",headers:{"Content-Type":"application/json","x-slack-request-timestamp":timestamp,"x-slack-signature":"v0="+signature},body:raw});
  };
  return {...db,env,deps,exchange,verify,responseValue,call,begin,callback,install,activate,decision,signed,workspaceId:workspace.workspaceId,otherWorkspaceId:other.workspaceId};
}

describe("native bot-workspace Slack installation",()=>{
  it("requires explicit PKCE consent and activation; stores only encrypted bound secrets and never returns a token",async()=>{
    const f=await fixture(),authorize=await f.begin();
    expect(authorize.origin+authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");expect(authorize.searchParams.has("user_scope")).toBe(false);
    const saved=f.sqlite.prepare("SELECT * FROM slack_installation_oauth").get()!;expect(JSON.stringify(saved)).not.toContain(authorize.searchParams.get("state")!);
    const done=await f.callback(authorize);expect(done?.status).toBe(303);expect(done?.headers.get("location")).toBe("https://shiba.test/app/?slackInstall=pending-review");expect(done?.headers.get("referrer-policy")).toBe("no-referrer");
    const [_url,init]=f.exchange.mock.calls[0]!,body=new URLSearchParams(String(init?.body));
    expect(body.has("client_secret")).toBe(false);expect(body.get("code_verifier")).toHaveLength(86);expect(init?.redirect).toBe("manual");
    const challenge=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body.get("code_verifier")!))).toString("base64url");expect(challenge).toBe(authorize.searchParams.get("code_challenge"));
    const pending=(await f.call()).value.installations[0]!;expect(pending).toMatchObject({state:"pending",canActivate:true,installerSlackUserId:"UINSTALLER"});
    expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();
    const activated=await f.call(`/${pending.id}/activate`,f.decision(pending)),snapshot=await activeSlackInstallationForTeam(f.env,"A123","T123");expect(activated.response.status).toBe(200);expect(snapshot).not.toBeNull();
    expect(await readSlackInstallationCredential(f.env,snapshot!)).toEqual({token:TOKEN});
    const ciphertext=f.sqlite.prepare("SELECT token_cipher FROM slack_installations").get()!;expect(JSON.stringify(ciphertext)).not.toContain(TOKEN);
    expect(JSON.stringify(activated.value)).not.toMatch(/xoxb|xoxe|token_cipher|token_key_id|refresh_token|code_verifier/);
    expect(activated.value.executionAvailable).toBe(false);
  });
  it.each(["disabled","pkce","logs","key","native","role"])("fails closed before OAuth when %s prerequisite is absent",async(which)=>{
    const f=await fixture();
    if(which==="disabled")f.env.SLACK_INSTALLATIONS_ENABLED="false";if(which==="pkce")f.env.SLACK_OAUTH_PKCE_ENABLED="false";if(which==="logs")f.env.SLACK_OAUTH_QUERY_REDACTION_VERIFIED="false";
    if(which==="key")f.env.SLACK_INSTALLATION_KEYRING="invalid";if(which==="native")identity.native=false;if(which==="role")f.sqlite.prepare("UPDATE team_workspace_memberships SET role='admin' WHERE user_id=?").run(OWNER);
    const result=await f.call("/begin",{requestId:crypto.randomUUID(),scopes:["chat:write"],consent:"install-bot-in-selected-slack-workspace"});expect(result.response.status).toBeGreaterThanOrEqual(400);expect(f.exchange).not.toHaveBeenCalled();
  });
  it("does not replay, renew, substitute the owner or accept an expired/forged state",async()=>{
    const f=await fixture(),authorize=await f.begin();identity.email=OTHER;expect((await f.callback(authorize))?.status).toBe(403);expect(f.exchange).not.toHaveBeenCalled();identity.email=OWNER;
    expect((await f.callback(authorize))?.status).toBe(303);expect((await f.callback(authorize))?.status).toBe(403);expect(f.exchange).toHaveBeenCalledTimes(1);
    const expired=await f.begin();f.sqlite.prepare("UPDATE slack_installation_oauth SET expires_at=1 WHERE state='pending'").run();expect((await f.callback(expired))?.status).toBe(403);
    expired.searchParams.set("state","x".repeat(43));expect((await f.callback(expired))?.status).toBe(403);expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it.each(["enterprise","user-token","app","team","scope"])("rejects unreviewed %s token responses",async(which)=>{
    const f=await fixture(),authorize=await f.begin();
    if(which==="enterprise")f.responseValue.is_enterprise_install=true;if(which==="user-token")Object.assign(f.responseValue.authed_user,{access_token:"xoxp-fixture"});if(which==="app")f.responseValue.app_id="AOTHER";if(which==="team")f.verify.mockResolvedValue({teamId:"OTHER",userId:"UB123",botId:"B123"});if(which==="scope")f.responseValue.scope="chat:write,admin";
    expect((await f.callback(authorize))?.status).toBeGreaterThanOrEqual(400);expect(f.sqlite.prepare("SELECT count(*) AS n FROM slack_installations").get()).toMatchObject({n:0});
    expect((await f.callback(authorize))?.status).toBe(403);expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("does not transfer a team to another native workspace owner",async()=>{
    const f=await fixture(),row=await f.activate();identity.email=OTHER;const authorize=await f.begin(f.otherWorkspaceId);expect((await f.callback(authorize))?.status).toBe(409);
    expect(f.sqlite.prepare("SELECT id,owner_id,state FROM slack_installations").get()).toMatchObject({id:row.id,owner_id:OWNER,state:"active"});
  });
  it("pins native account UUID and version, with no removal/readd revival",async()=>{
    const f=await fixture(),snapshot=await f.activate();f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE user_id=?").run(OWNER);f.sqlite.prepare("UPDATE team_workspace_memberships SET status='active',version=version+1 WHERE user_id=?").run(OWNER);
    expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();await expect(readSlackInstallationCredential(f.env,snapshot)).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT state,token_cipher FROM slack_installations").get()).toMatchObject({state:"blocked",token_cipher:null});
  });
  it("rejects same-email native UUID replacement before exchanging any code",async()=>{
    const f=await fixture(),authorize=await f.begin(),original=identity.accounts[OWNER]!;
    f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(original);f.sqlite.prepare("DELETE FROM shiba_auth_account_policy WHERE account_id=?").run(original);
    identity.accounts[OWNER]=crypto.randomUUID();f.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(identity.accounts[OWNER]!,OWNER);f.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?)").run(identity.accounts[OWNER]!,OWNER);
    expect((await f.callback(authorize))?.status).toBe(403);expect(f.exchange).not.toHaveBeenCalled();
  });
  it("rejects replayed or changed activation decisions and keeps reinstall generations separate",async()=>{
    const f=await fixture(),pending=await f.install();
    expect((await f.call(`/${pending.id}/activate`,{...f.decision(pending),digest:"f".repeat(64)})).response.status).toBe(409);
    const active=(await f.call(`/${pending.id}/activate`,f.decision(pending))).value.installations[0]!;
    expect((await f.call(`/${pending.id}/activate`,f.decision(pending))).response.status).toBe(409);
    const authorize=await f.begin();expect((await f.callback(authorize))?.status).toBe(303);
    await expect(readSlackInstallationCredential(f.env,active)).rejects.toThrow();const again=(await f.call()).value.installations[0]!;
    expect(again).toMatchObject({state:"pending",generation:active.generation+1});expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();
  });
  it("does not exchange a verifier transplanted from another owner's pending installation",async()=>{
    const f=await fixture(),first=await f.begin();identity.email=OTHER;await f.begin(f.otherWorkspaceId);identity.email=OWNER;
    f.sqlite.prepare("UPDATE slack_installation_oauth SET verifier_cipher=(SELECT verifier_cipher FROM slack_installation_oauth WHERE owner_account_id=?) WHERE owner_account_id=?").run(identity.accounts[OTHER]!,identity.accounts[OWNER]!);
    expect((await f.callback(first))?.status).toBe(503);expect(f.exchange).not.toHaveBeenCalled();
  });
  it("refreshes once with a new revision and never retries an uncertain refresh",async()=>{
    const f=await fixture(),row=await f.activate();const result=await f.call(`/${row.id}/refresh`,f.decision(row));expect(result.response.status,JSON.stringify(result.value)).toBe(200);expect(result.value.installations[0]?.tokenRevision).toBe(row.tokenRevision+1);
    const refreshBody=new URLSearchParams(String(f.exchange.mock.calls[1]?.[1]?.body));expect(refreshBody.get("grant_type")).toBe("refresh_token");expect(refreshBody.has("code_verifier")).toBe(false);expect(refreshBody.has("client_secret")).toBe(false);
    await expect(readSlackInstallationCredential(f.env,row)).rejects.toThrow();
    const current=result.value.installations[0]!,broken={...f.deps,fetch:vi.fn(async()=>{throw new Error("uncertain transport");})};
    expect((await f.call(`/${current.id}/refresh`,f.decision(current),f.workspaceId,broken)).response.status).toBe(503);
    expect((await f.call(`/${current.id}/refresh`,f.decision(current),f.workspaceId,broken)).response.status).toBe(409);expect(broken.fetch).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare("SELECT state,token_cipher FROM slack_installations").get()).toMatchObject({state:"unknown",token_cipher:null});
  });
  it("supports explicit keyring rotation but rejects swapped scope or missing old keys",async()=>{
    const f=await fixture(),snapshot=await f.activate();f.env.SLACK_INSTALLATION_KEYRING=JSON.stringify({activeKeyId:"v2",keys:{v2:"22".repeat(32),v1:"11".repeat(32)}});expect(await readSlackInstallationCredential(f.env,snapshot)).toEqual({token:TOKEN});
    const sealed=await sealSlackSecret(f.env,{workspaceId:f.workspaceId,subject:"bound",purpose:"purpose"},"fixture-secret");expect(sealed.keyId).toBe("v2");
    await expect(openSlackSecret(f.env,{workspaceId:f.workspaceId,subject:"other",purpose:"purpose"},sealed)).rejects.toThrow();
    f.env.SLACK_INSTALLATION_KEYRING=JSON.stringify({activeKeyId:"v2",keys:{v2:"22".repeat(32)}});await expect(readSlackInstallationCredential(f.env,snapshot)).rejects.toThrow();
  });
  it("makes two concurrent refresh decisions consume only one provider refresh",async()=>{
    const f=await fixture(),row=await f.activate();let release!:(value:Response)=>void,arrived!:()=>void;
    const waiting=new Promise<Response>((resolve)=>{release=resolve;}),started=new Promise<void>((resolve)=>{arrived=resolve;});
    const fetcher=vi.fn(async()=>{arrived();return waiting;}),deps={...f.deps,fetch:fetcher};
    const first=f.call(`/${row.id}/refresh`,f.decision(row),f.workspaceId,deps);await started;
    expect((await f.call(`/${row.id}/refresh`,f.decision(row),f.workspaceId,deps)).response.status).toBe(409);
    release(Response.json(f.responseValue));expect((await first).response.status).toBe(200);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("blocks a delayed refresh result after native owner removal",async()=>{
    const f=await fixture(),row=await f.activate(),deps={...f.deps,fetch:vi.fn(async()=>{
      f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE user_id=?").run(OWNER);return Response.json(f.responseValue);
    })};
    expect((await f.call(`/${row.id}/refresh`,f.decision(row),f.workspaceId,deps)).response.status).toBe(503);
    expect(f.sqlite.prepare("SELECT state,token_cipher FROM slack_installations").get()).toMatchObject({state:"blocked",token_cipher:null});
    expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();
  });
  it("verifies raw signatures before routing, blocks every tenant fallback and processes monotonic revocation",async()=>{
    const f=await fixture(),snapshot=await f.activate(),body={type:"event_callback",api_app_id:"A123",team_id:"T123",event_id:"Ev123",event:{type:"app_mention",user:"UOTHER",channel:"C123",text:"Run using operator credentials"}};
    const forged=new Request("https://shiba.test/api/slack/events",{method:"POST",body:JSON.stringify(body)});expect((await handleMultiInstallationSlackCallback(forged,f.env))?.status).toBe(401);
    expect((await handleMultiInstallationSlackCallback(await f.signed(body),f.env))?.status).toBe(200);
    f.env.SLACK_LEGACY_MODE_ENABLED="true";f.env.SLACK_LEGACY_TEAM_ID="T123";f.env.SLACK_LEGACY_APP_ID="A123";
    expect(await handleMultiInstallationSlackCallback(await f.signed(body),f.env)).not.toBeNull();
    const revoke={...body,event_id:"EvRevoke",event:{type:"tokens_revoked",tokens:{bot:["UB123"]}}};
    expect((await handleMultiInstallationSlackCallback(await f.signed(revoke),f.env))?.status).toBe(200);expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();
    await expect(readSlackInstallationCredential(f.env,snapshot)).rejects.toThrow();const generation=f.sqlite.prepare("SELECT generation FROM slack_installations").get();await handleMultiInstallationSlackCallback(await f.signed(revoke),f.env);expect(f.sqlite.prepare("SELECT generation FROM slack_installations").get()).toEqual(generation);
    expect(await handleMultiInstallationSlackCallback(await f.signed(body),f.env)).not.toBeNull();
    f.env.SLACK_LEGACY_TEAM_ID="TLEGACY";expect(await handleMultiInstallationSlackCallback(await f.signed({...body,team_id:"TLEGACY"}),f.env)).toBeNull();
    expect(await handleMultiInstallationSlackCallback(await f.signed({...body,team_id:"UNKNOWN"}),f.env)).not.toBeNull();
  });
  it("returns an actionable signed command response without borrowing the operator's payer",async()=>{
    const f=await fixture();await f.activate();
    const request=await f.signed(new URLSearchParams({api_app_id:"A123",team_id:"T123",user_id:"U_REQUESTER",command:"/shiba",text:"start work"}).toString(),"/api/slack/command");
    const response=await handleMultiInstallationSlackCallback(request,f.env);expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({response_type:"ephemeral",text:expect.stringContaining("provider/billing")});
  });
  it("blocks activation of OAuth work begun before an uninstall notice",async()=>{
    const f=await fixture(),authorize=await f.begin();await handleMultiInstallationSlackCallback(await f.signed({type:"event_callback",api_app_id:"A123",team_id:"T123",event_id:"EvUninstall",event:{type:"app_uninstalled"}}),f.env);
    expect((await f.callback(authorize))?.status).toBe(403);expect(f.sqlite.prepare("SELECT count(*) AS n FROM slack_installations").get()).toMatchObject({n:0});
  });
  it("still revokes a known installation when the bounded event journal is full",async()=>{
    const f=await fixture(),snapshot=await f.activate();
    f.sqlite.exec("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<10000) INSERT INTO slack_installation_events SELECT 'AJOURNAL','TJOURNAL','Ev'||v,0 FROM n");
    expect((await handleMultiInstallationSlackCallback(await f.signed({type:'event_callback',api_app_id:'A123',team_id:'T123',event_id:'EvAtCapacity',event:{type:'app_uninstalled'}}),f.env))?.status).toBe(200);
    expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();await expect(readSlackInstallationCredential(f.env,snapshot)).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM slack_installation_events").get()).toMatchObject({n:10000});
  });
  it.each(["active","revoked"])("retains managed tenant denial with the feature disabled: %s",async(state)=>{
    const f=await fixture();await f.activate();
    if(state==="revoked")f.sqlite.prepare("UPDATE slack_installations SET state='revoked'").run();
    f.env.SLACK_INSTALLATIONS_ENABLED="false";f.env.SLACK_LEGACY_MODE_ENABLED="true";f.env.SLACK_LEGACY_TEAM_ID="T123";f.env.SLACK_LEGACY_APP_ID="A123";
    const event={type:"event_callback",api_app_id:"A123",team_id:"T123",event_id:"EvDisabled",event:{type:"app_mention",text:"Must not use operator token"}};
    expect(await handleMultiInstallationSlackCallback(await f.signed(event),f.env)).not.toBeNull();
    expect(await handleMultiInstallationSlackCallback(await f.signed({...event,team_id:"UNTREATED_LEGACY"}),f.env)).toBeNull();
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it("retains signed revocation while disabled and cannot revive it by enabling the feature",async()=>{
    const f=await fixture(),snapshot=await f.activate();f.env.SLACK_INSTALLATIONS_ENABLED="false";
    expect((await handleMultiInstallationSlackCallback(await f.signed({type:"event_callback",api_app_id:"A123",team_id:"T123",event_id:"EvDisabledUninstall",event:{type:"app_uninstalled"}}),f.env))?.status).toBe(200);
    f.env.SLACK_INSTALLATIONS_ENABLED="true";
    expect(await activeSlackInstallationForTeam(f.env,"A123","T123")).toBeNull();await expect(readSlackInstallationCredential(f.env,snapshot)).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT state,generation FROM slack_installations").get()).toMatchObject({state:"revoked",generation:snapshot.generation+1});
  });
  it("applies the migration twice on a fresh database with runtime schema parity",()=>{
    const sqlite=new DatabaseSync(":memory:"),sql=readFileSync(new URL("../migrations/0018_slack_installations.sql",import.meta.url),"utf8");sqlite.exec(sql);sqlite.exec(sql);for(const statement of SLACK_INSTALLATION_SCHEMA)sqlite.exec(statement);
    expect(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'slack_installations_owner_%'").get()).toMatchObject({n:2});sqlite.close();
  });
  it("checks bot metadata on the fixed endpoint without redirects or raw error leakage",async()=>{
    const transport=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({ok:true,team_id:"T123",user_id:"UB123",bot_id:"B123"}));vi.stubGlobal("fetch",transport);
    await expect(verifySlackInstallationBot(TOKEN)).resolves.toEqual({teamId:"T123",userId:"UB123",botId:"B123"});
    expect(transport).toHaveBeenCalledExactlyOnceWith("https://slack.com/api/auth.test",expect.objectContaining({method:"POST",redirect:"manual"}));
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
  it.each([{ok:true,team_id:"T123",user_id:"UB123",bot_id:"B123",enterprise_id:"E123"},{ok:false,error:"sensitive-raw-provider-detail"}])("rejects unsupported or failed bot identity metadata",async(value)=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(value)));
    await expect(verifySlackInstallationBot(TOKEN)).rejects.toMatchObject({code:"slack_installation_identity_unavailable"});
  });
});
