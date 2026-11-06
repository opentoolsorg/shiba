import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createStripeDraft, getStripeGrant, stripeTransition, revokeStripeGrant, type StripeEnv } from "../src/founder-stripe-store.js";
import { tickFounderStripeReads, verifyFounderStripeAccount } from "../src/founder-stripe-runtime.js";
import { handleFounderStripeReads } from "../src/founder-stripe-routes.js";
vi.mock("../src/request-auth.js", async original => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => "stripe-owner@example.test" }));
vi.mock("@shiba/auth/better-auth", async original => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => ({ policy: { accountId: "native-owner", email: "stripe-owner@example.test", kind: "invited" }, emailVerified: true, sessionId: "session-fixture", sessionExpiresAt: Date.now()+86400000 }) }));
const email="stripe-owner@example.test", account="native-owner";
const session=()=>({id:"session-fixture",expiresAt:Date.now()+86400000});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){const db=customAgentD1();db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT)');db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(account,email);db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(account,email);db.sqlite.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');db.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run('session-fixture',account,Date.now()+86400000);db.sqlite.exec(readFileSync(new URL('../migrations/0027_founder_stripe_reads.sql',import.meta.url),'utf8'));const env={AGENT_AUDIT:db.database,FOUNDER_STRIPE_READS_ENABLED:"true",FOUNDER_STRIPE_CREDENTIAL_KEY:"ab".repeat(32)} as StripeEnv;const workspace=await createTeamWorkspace(env,email,{name:"Stripe fixture"}),member={...(await getTeamWorkspaceMembership(env,workspace.workspaceId,email))!,accountId:account};const input={accountId:"acct_Fixture",mode:"test",restrictedKey:`rk_test_${"F".repeat(24)}`,expiresAt:Date.now()+86400000,maxCalls:2,selection:{kind:"balance_transactions",createdGte:100,createdLt:200,limit:2},readOnlyAttestation:"restricted-key-read-only-for-selected-resources"};return{db,env,member,input};}

async function enabled() {
  const f = await fixture(), draft = await createStripeDraft(f.env, f.member, f.input, session());
  const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ object: "account", id: "acct_Fixture" })); vi.stubGlobal("fetch", network);
  await verifyFounderStripeAccount(f.env, f.member, draft.id, draft.digest, session());
  await stripeTransition(f.env, f.member, draft.id, "verified", "enabled", draft.digest, session());
  f.db.sqlite.prepare("UPDATE founder_stripe_read_grants SET next_due_at=? WHERE id=?").run(Date.now() - 1000, draft.id);
  network.mockClear(); network.mockImplementation(async () => Response.json({ object: "list", has_more: false, data: [] }));
  return { ...f, draft, network };
}
describe("independent Stripe native session revocation", () => {
  it("does not reserve quota or call Stripe for manual verification after session deletion", async () => {
    const f=await fixture(),draft=await createStripeDraft(f.env,f.member,f.input, session()),network=vi.fn(async()=>Response.json({object:"account",id:"acct_Fixture"}));vi.stubGlobal("fetch",network);
    const prepare=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);let deleted=false;
    const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){
      if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
      if(property==="first")return async()=>{const result=await target.first();if(!deleted&&sql.includes("SELECT * FROM founder_stripe_read_grants WHERE id")){deleted=true;f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run("session-fixture");}return result;};
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});f.env.AGENT_AUDIT.prepare=(sql)=>wrap(prepare(sql),sql);
    const response=await handleFounderStripeReads(new Request(`https://shiba.test/api/founder-stripe-reads/${draft.id}/verify`,{method:"POST",headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture",Origin:"https://shiba.test","Content-Type":"application/json"},body:JSON.stringify({digest:draft.digest,reviewed:true,readConsent:"allow-exact-scheduled-stripe-reads-and-quota",readOnlyAttestation:"restricted-key-read-only-for-selected-resources"})}),f.env);
    expect(deleted).toBe(true);expect(response!.status).not.toBe(200);expect(network).not.toHaveBeenCalled();
    expect(f.db.sqlite.prepare("SELECT state,used_calls FROM founder_stripe_read_grants WHERE id=?").get(draft.id)).toEqual({state:"draft",used_calls:0});
  });
  it("does not commit native enable after its deciding session disappears during the grant read", async () => {
    const f=await fixture(),draft=await createStripeDraft(f.env,f.member,f.input, session());
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({object:"account",id:"acct_Fixture"})));
    await verifyFounderStripeAccount(f.env,f.member,draft.id,draft.digest, session());
    const prepare=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);let deleted=false;
    const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){
      if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
      if(property==="first")return async()=>{const result=await target.first();if(!deleted&&sql.includes("SELECT * FROM founder_stripe_read_grants WHERE id")){deleted=true;f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run("session-fixture");}return result;};
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});f.env.AGENT_AUDIT.prepare=(sql)=>wrap(prepare(sql),sql);
    const response=await handleFounderStripeReads(new Request(`https://shiba.test/api/founder-stripe-reads/${draft.id}/enable`,{method:"POST",headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture",Origin:"https://shiba.test","Content-Type":"application/json"},body:JSON.stringify({digest:draft.digest,reviewed:true,readConsent:"allow-exact-scheduled-stripe-reads-and-quota",readOnlyAttestation:"restricted-key-read-only-for-selected-resources"})}),f.env);
    expect(deleted).toBe(true);expect(response!.status).not.toBe(200);
    expect(f.db.sqlite.prepare("SELECT state FROM founder_stripe_read_grants WHERE id=?").get(draft.id)).toEqual({state:"verified"});
  });
  it("withholds private report bytes after its exact native session is deleted during the source read", async () => {
    const f=await enabled(); await tickFounderStripeReads(f.env);
    const receipt=f.db.sqlite.prepare("SELECT id FROM founder_stripe_read_receipts WHERE state='completed'").get()!;
    const prepare=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT); let deleted=false;
    const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){
      if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
      if(property==="first")return async()=>{const result=await target.first();if(!deleted&&sql.includes("SELECT r.report_json")){deleted=true;f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run("session-fixture");}return result;};
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});
    f.env.AGENT_AUDIT.prepare=(sql)=>wrap(prepare(sql),sql);
    const response=await handleFounderStripeReads(new Request(`https://shiba.test/api/founder-stripe-reads/${f.draft.id}/reports/${receipt.id}`,{headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture"}}),f.env);
    expect(deleted).toBe(true); expect(response!.status).not.toBe(200); expect(await response!.text()).not.toContain("shiba.stripe-read-report.v1");
  });
});
