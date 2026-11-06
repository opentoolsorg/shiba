import { afterEach,expect,it,vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace,getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createMetaDraft,getMetaGrant,enableMetaGrant,revokeMetaGrant,type MetaEnv } from "../src/founder-meta-store.js";
import { verifyFounderMetaAccount,tickFounderMetaReads } from "../src/founder-meta-runtime.js";
import { metaAccountUrl,metaInsightsUrl,projectMetaInsights } from "../src/founder-meta-read.js";
import { handleFounderMetaReads } from "../src/founder-meta-routes.js";
const native=vi.hoisted(()=>({expiresAt:Date.now()+86400000}));
vi.mock("../src/request-auth.js", async original => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => "meta-owner@example.test" }));
vi.mock("@shiba/auth/better-auth", async original => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => ({ policy: { accountId: "native-owner", email: "meta-owner@example.test", kind: "invited" }, emailVerified: true, sessionId:"session-fixture", sessionExpiresAt:native.expiresAt }) }));
const email="meta-owner@example.test",account="native-owner";
const session=()=>({id:"session-fixture",expiresAt:native.expiresAt});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();native.expiresAt=Date.now()+86400000;});
async function fixture(){const db=customAgentD1();db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(account,email);db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(account,email);db.sqlite.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');db.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run('session-fixture',account,native.expiresAt);db.sqlite.exec(readFileSync(new URL('../migrations/0029_founder_meta_reads.sql',import.meta.url),'utf8'));const env={AGENT_AUDIT:db.database,FOUNDER_META_READS_ENABLED:"true",FOUNDER_META_CREDENTIAL_KEY:"ab".repeat(32)} as MetaEnv;const workspace=await createTeamWorkspace(env,email,{name:"Meta fixture"}),member={...(await getTeamWorkspaceMembership(env,workspace.workspaceId,email))!,accountId:account};const input={accountId:"123456",accessToken:"fixtureMetaToken123456789",expiresAt:Date.now()+86400000,maxCalls:2,selection:{since:"2025-01-01",until:"2025-01-07",limit:2},credentialAttestation:"creator-attests-token-appropriate-for-ads-read"};return{db,env,member,input};}
const accountWire={id:"act_123456",account_id:"123456",currency:"USD",timezone_name:"America/New_York"};
const insightWire={data:[{impressions:"120",clicks:"3",spend:"2.10",account_currency:"USD",date_start:"2025-01-01",date_stop:"2025-01-07",private:"discard"}]};

async function captured(){
 const f=await fixture(),draft=await createMetaDraft(f.env,f.member,f.input,session());
 const network=vi.fn(async(url:RequestInfo|URL)=>Response.json(String(url).includes("/insights")?insightWire:accountWire));vi.stubGlobal("fetch",network);
 await verifyFounderMetaAccount(f.env,f.member,draft.id,draft.digest,session());
 const grant=(await getMetaGrant(f.env,f.member,draft.id))!;await enableMetaGrant(f.env,f.member,draft.id,grant.contract_digest,session());
 f.db.sqlite.prepare("UPDATE founder_meta_read_grants SET next_due_at=? WHERE id=?").run(Date.now()-1000,draft.id);
 await tickFounderMetaReads(f.env);
 const receipt=f.db.sqlite.prepare("SELECT id FROM founder_meta_read_receipts WHERE state='completed'").get()!;
 const read=()=>handleFounderMetaReads(new Request(`https://shiba.test/api/founder-meta-reads/${draft.id}/reports/${receipt.id}`,{headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture"}}),f.env);
 expect((await read())?.status).toBe(200);
 return {...f,draft,grant,receipt,read,network};
}
function intercept(env:MetaEnv, needle:string, after:boolean, run:()=>void){
 const prepare=env.AGENT_AUDIT.prepare.bind(env.AGENT_AUDIT);let hit=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){
  if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
  if(property==="first")return async()=>{const selected=!hit&&sql.includes(needle);if(selected){hit=true;if(!after)run();}const result=await target.first();if(selected&&after)run();return result;};
  const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
 }});env.AGENT_AUDIT.prepare=(sql)=>wrap(prepare(sql),sql);return()=>hit;
}
it("withholds Meta bytes when the original native session disappears during an earlier receipt await",async()=>{
 const f=await captured(),hit=intercept(f.env,"SELECT r.report_json",true,()=>{f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run("session-fixture");});
 const response=await f.read();expect(hit()).toBe(true);expect(response?.status).toBe(403);expect(await response!.text()).not.toContain("shiba.meta-read-report.v1");
});
it("rechecks source revocation in the final combined native-session read",async()=>{
 const f=await captured(),hit=intercept(f.env,"SELECT s.expiresAt",false,()=>{f.db.sqlite.prepare("UPDATE founder_meta_read_grants SET state='revoked',ciphertext='' WHERE id=?").run(f.draft.id);});
 const response=await f.read();expect(hit()).toBe(true);expect(response?.status).toBe(403);expect(await response!.text()).not.toContain("shiba.meta-read-report.v1");
});
it.each(["session","receipt"])("checks %s expiry synchronously after its final successful SQL proof returns",async(which)=>{
 const f=await captured(),deadline=Date.now()+60000;
 const id=which==="session"?"session-fixture":f.receipt.id;if(typeof id!=="string")throw new Error("Fixture receipt ID missing");
 f.db.sqlite.prepare(which==="session"?'UPDATE "session" SET expiresAt=? WHERE id=?':"UPDATE founder_meta_read_receipts SET expires_at=? WHERE id=?").run(deadline,id);
 const hit=intercept(f.env,"SELECT s.expiresAt",true,()=>{vi.spyOn(Date,"now").mockReturnValue(deadline+1);});
 const response=await f.read();expect(hit()).toBe(true);expect(response?.status).toBe(403);expect(await response!.text()).not.toContain("shiba.meta-read-report.v1");
});
it("does not enable future reads when the deciding native session is revoked during the decision await",async()=>{
 const f=await fixture(),draft=await createMetaDraft(f.env,f.member,f.input,session());
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json(accountWire)));
 await verifyFounderMetaAccount(f.env,f.member,draft.id,draft.digest,session());
 const grant=(await getMetaGrant(f.env,f.member,draft.id))!;
 const hit=intercept(f.env,"SELECT * FROM founder_meta_read_grants WHERE id",true,()=>{f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run("session-fixture");});
 const response=await handleFounderMetaReads(new Request(`https://shiba.test/api/founder-meta-reads/${draft.id}/enable`,{method:"POST",headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture",Origin:"https://shiba.test","Content-Type":"application/json"},body:JSON.stringify({digest:grant.contract_digest,reviewed:true,readConsent:"allow-exact-daily-meta-reads-and-quota",credentialAttestation:"creator-attests-token-appropriate-for-ads-read"})}),f.env);
 expect(hit()).toBe(true);expect(response?.status).not.toBe(200);
 expect(f.db.sqlite.prepare("SELECT state FROM founder_meta_read_grants WHERE id=?").get(draft.id)).toEqual({state:"verified"});
});
it("consumes only one competing scheduled call and permanently holds an unknown outcome",async()=>{
 const f=await fixture(),draft=await createMetaDraft(f.env,f.member,{...f.input,maxCalls:3},session());
 const network=vi.fn(async()=>Response.json(accountWire));vi.stubGlobal("fetch",network);
 await verifyFounderMetaAccount(f.env,f.member,draft.id,draft.digest,session());const verified=(await getMetaGrant(f.env,f.member,draft.id))!;
 await enableMetaGrant(f.env,f.member,draft.id,verified.contract_digest,session());f.db.sqlite.prepare("UPDATE founder_meta_read_grants SET next_due_at=? WHERE id=?").run(Date.now()-1000,draft.id);
 network.mockClear();network.mockRejectedValue(new Error("fixture unknown provider outcome"));
 await Promise.all([tickFounderMetaReads(f.env),tickFounderMetaReads(f.env)]);await tickFounderMetaReads(f.env);
 expect(network).toHaveBeenCalledTimes(1);expect(f.db.sqlite.prepare("SELECT state,used_calls FROM founder_meta_read_grants WHERE id=?").get(draft.id)).toEqual({state:"blocked",used_calls:2});
 expect(f.db.sqlite.prepare("SELECT state,report_json FROM founder_meta_read_receipts").all()).toEqual([{state:"unknown",report_json:null}]);
});
it("does not dispatch after source revocation arrives with a successful atomic reservation acknowledgement",async()=>{
 const f=await fixture(),draft=await createMetaDraft(f.env,f.member,f.input,session());
 const network=vi.fn(async()=>Response.json(accountWire));vi.stubGlobal("fetch",network);
 await verifyFounderMetaAccount(f.env,f.member,draft.id,draft.digest,session());const verified=(await getMetaGrant(f.env,f.member,draft.id))!;
 await enableMetaGrant(f.env,f.member,draft.id,verified.contract_digest,session());f.db.sqlite.prepare("UPDATE founder_meta_read_grants SET next_due_at=? WHERE id=?").run(Date.now()-1000,draft.id);
 network.mockClear();const batch=f.env.AGENT_AUDIT.batch.bind(f.env.AGENT_AUDIT);let revoked=false;
 f.env.AGENT_AUDIT.batch=async<T=unknown>(statements:D1PreparedStatement[])=>{const result=await batch<T>(statements);if(!revoked){revoked=true;await revokeMetaGrant(f.env,f.member,draft.id,verified.contract_digest,session());}return result;};
 await tickFounderMetaReads(f.env);expect(revoked).toBe(true);expect(network).not.toHaveBeenCalled();
 expect(f.db.sqlite.prepare("SELECT state,ciphertext,used_calls FROM founder_meta_read_grants WHERE id=?").get(draft.id)).toEqual({state:"revoked",ciphertext:"",used_calls:2});
});
it("does not manually verify after its native session lease expires while final proof is returning",async()=>{
 const f=await fixture(),draft=await createMetaDraft(f.env,f.member,f.input,session()),deadline=Date.now()+60000;
 native.expiresAt=deadline;f.db.sqlite.prepare('UPDATE "session" SET expiresAt=? WHERE id=?').run(deadline,"session-fixture");
 const network=vi.fn(async()=>Response.json(accountWire));vi.stubGlobal("fetch",network);
 const hit=intercept(f.env,"FROM founder_meta_read_grants WHERE id=? AND revision=? AND contract_digest=?",true,()=>{vi.spyOn(Date,"now").mockReturnValue(deadline+1);});
 await verifyFounderMetaAccount(f.env,f.member,draft.id,draft.digest,session()).catch(()=>undefined);
 expect(hit()).toBe(true);expect(network).not.toHaveBeenCalled();
});
