import { afterEach,describe,it,expect,vi } from "vitest";
import { readFileSync } from "node:fs";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createTeamWorkspace,getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createStripeDraft,stripeDigest,type StripeEnv } from "../src/founder-stripe-store.js";
import { createHubSpotDraft,getHubSpotGrant,enableHubSpotGrant,type HubSpotEnv } from "../src/founder-hubspot-store.js";
import { verifyFounderHubSpotAccount,tickFounderHubSpotReads } from "../src/founder-hubspot-runtime.js";
import { loadReconciliationSources } from "../src/founder-reconciliation-sources.js";
const source=vi.hoisted(()=>({authority:null as unknown,expiresAt:Date.now()+86400000}));
import { createFounderReconciliation,composeFounderReconciliation,readFounderReconciliation } from "../src/founder-reconciliation-store.js";
vi.mock("../src/founder-auto-read-store.js",async original=>({...await original<typeof import("../src/founder-auto-read-store.js")>(),automaticAvailability:()=>null}));
import { handleFounderReconciliations } from "../src/founder-reconciliation-routes.js";
vi.mock("../src/request-auth.js",async original=>({...await original<typeof import("../src/request-auth.js")>(),isAuthorizedRequest:async()=>true,resolveUserId:async()=>"fixture@example.test"}));
vi.mock("@shiba/auth/better-auth",async original=>({...await original<typeof import("@shiba/auth/better-auth")>(),resolveBetterAuthSessionAccount:async()=>({policy:{accountId:"native-fixture",email:"fixture@example.test",kind:"invited"},emailVerified:true,sessionId:"fixture-session",sessionExpiresAt:source.expiresAt})}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){
 const db=customAgentD1(),email="fixture@example.test",account="native-fixture";db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT);CREATE TABLE hub_fixture(current INTEGER);INSERT INTO hub_fixture VALUES(1)');db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(account,email);db.sqlite.prepare('INSERT INTO shiba_auth_account_policy VALUES(?,?)').run(account,email);db.sqlite.exec(readFileSync(new URL('../migrations/0027_founder_stripe_reads.sql',import.meta.url),'utf8'));
 const env={AGENT_AUDIT:db.database,FOUNDER_STRIPE_READS_ENABLED:"true",FOUNDER_STRIPE_CREDENTIAL_KEY:"ab".repeat(32),FOUNDER_HUBSPOT_READS_ENABLED:"true",FOUNDER_HUBSPOT_CREDENTIAL_KEY:"cd".repeat(32)} as StripeEnv & HubSpotEnv,ws=await createTeamWorkspace(env,email,{name:"Fixture"}),member={...(await getTeamWorkspaceMembership(env,ws.workspaceId,email))!,accountId:account},expires=Date.now()+600000,selection={kind:"invoices",createdGte:100,createdLt:200,limit:5};
 db.sqlite.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');db.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run('fixture-session',account,expires);db.sqlite.exec(readFileSync(new URL('../migrations/0030_founder_reconciliation.sql',import.meta.url),'utf8'));db.sqlite.exec(readFileSync(new URL('../migrations/0032_founder_hubspot_reads.sql',import.meta.url),'utf8'));
 const grant=await createStripeDraft(env,member,{accountId:"acct_Fixture",mode:"test",restrictedKey:`rk_test_${"F".repeat(24)}`,expiresAt:expires,maxCalls:2,selection,readOnlyAttestation:"restricted-key-read-only-for-selected-resources"},{id:"fixture-session",expiresAt:expires});db.sqlite.prepare("UPDATE founder_stripe_read_grants SET state='enabled' WHERE id=?").run(grant.id);const pin=(db.sqlite.prepare("SELECT executor_digest FROM founder_stripe_read_grants WHERE id=?").get(grant.id) as {executor_digest:string}).executor_digest,receipt=`fsr_${"b".repeat(32)}`;
 const stripe=JSON.stringify({format:"shiba.stripe-read-report.v1",grantId:grant.id,revision:1,accountId:"acct_Fixture",mode:"test",contractDigest:grant.digest,executorDigest:pin,capturedAt:Date.now(),capture:{kind:"invoices",interval:{createdGte:100,createdLt:200},hasMore:false,rows:[{id:"in_A",currency:"usd",amountPaid:1000,status:"paid",created:150,livemode:false}],datasetCompleteness:"unknown",businessSuccess:"unverified"}});db.sqlite.prepare("INSERT INTO founder_stripe_read_receipts VALUES(?,?,?,'completed',?,?,?,?,?)").run(receipt,grant.id,1,JSON.stringify(selection),stripe,await stripeDigest(stripe),Date.now(),expires);
 const hub=await createHubSpotDraft(env,member,{accountId:"123",accessToken:"fixture-hubspot-token-123456789",expiresAt:expires,maxCalls:2,selection:{dealIds:["1","2"],invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency"},credentialAttestation:"creator-attests-token-appropriate-for-hubspot-deals-read"},{id:"fixture-session",expiresAt:expires});vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith("/details")?Response.json({portalId:123,companyCurrency:"USD",timeZone:"UTC"}):Response.json({status:"COMPLETE",results:[{id:"1",properties:{invoice_id:"in_A",paid_amount:"10.00",currency:"USD"}}]})));await verifyFounderHubSpotAccount(env,member,hub.id,hub.digest,{id:"fixture-session",expiresAt:expires});const verified=(await getHubSpotGrant(env,member,hub.id))!;await enableHubSpotGrant(env,member,hub.id,verified.contract_digest,{id:"fixture-session",expiresAt:expires});db.sqlite.prepare("UPDATE founder_hubspot_read_grants SET next_due_at=?").run(Date.now()-1000);await tickFounderHubSpotReads(env);vi.unstubAllGlobals();const hubReceipt=(db.sqlite.prepare("SELECT id FROM founder_hubspot_read_receipts WHERE state='completed'").get() as {id:string}).id;
 const input={hubspot:{grantId:hub.id,grantVersion:1,occurrenceId:hubReceipt,sourceOrdinal:0 as const},stripe:{grantId:grant.id,receiptId:receipt},mapping:{invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency",amountUnit:"major-decimal" as const,basisAttestation:"crm-property-represents-stripe-invoice-amount-paid" as const},expiresAt:expires-1000};
 source.expiresAt=expires;return {db,env,member,input,grant,receipt,session:{id:"fixture-session",expiresAt:expires}};
}
function beforeStatement(env:StripeEnv,needle:string,method:"first"|"run",run:()=>void,after=false){const prepare=env.AGENT_AUDIT.prepare.bind(env.AGENT_AUDIT);let hit=false;const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,property){if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);if(property===method)return async()=>{const selected=!hit&&sql.includes(needle);if(selected){hit=true;if(!after)run();}const result=await(method==="first"?target.first():target.run());if(selected&&after)run();return result;};const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}});env.AGENT_AUDIT.prepare=sql=>wrap(prepare(sql),sql);return()=>hit;}
describe("independent reconciliation with real stored Stripe source and SQL proof",()=>{
 it.each(["session","source"])("withholds route bytes after %s revocation between store proof and route output",async(kind)=>{
  const f=await fixture(),draft=(await createFounderReconciliation(f.env,f.member,f.input,f.session)).draft;
  await composeFounderReconciliation(f.env,f.member,draft.id,draft.digest,f.session);
  const request=()=>new Request(`https://shiba.test/api/founder-reconciliations/${draft.id}`,{headers:{"X-Shiba-Workspace":f.member.workspaceId,cookie:"better-auth.session_token=fixture"}});
  expect((await handleFounderReconciliations(request(),f.env))?.status).toBe(200);
  const hit=beforeStatement(f.env,"SELECT s.expiresAt AS session_expires FROM founder_reconciliation_reports","first",()=>{
   if(kind==="session")f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run(f.session.id);
   else f.db.sqlite.prepare("UPDATE founder_stripe_read_grants SET state='revoked',ciphertext='' WHERE id=?").run(f.grant.id);
  },true);
  const response=await handleFounderReconciliations(request(),f.env);expect(hit()).toBe(true);expect(response?.status).toBe(403);expect(await response!.text()).not.toContain("crmMinor");
 });

 it("cannot commit composition after deciding session is removed just before its atomic write",async()=>{
  const f=await fixture(),draft=(await createFounderReconciliation(f.env,f.member,f.input,f.session)).draft;
  const hit=beforeStatement(f.env,"UPDATE founder_reconciliation_reports SET state='completed'","run",()=>{f.db.sqlite.prepare('DELETE FROM "session" WHERE id=?').run(f.session.id);});
  await expect(composeFounderReconciliation(f.env,f.member,draft.id,draft.digest,f.session)).rejects.toThrow();expect(hit()).toBe(true);
  expect(f.db.sqlite.prepare("SELECT state,report_json FROM founder_reconciliation_reports").get()).toEqual({state:"draft",report_json:null});
 });
 it("rechecks actual Stripe revocation in its final combined private report proof",async()=>{
  const f=await fixture(),draft=(await createFounderReconciliation(f.env,f.member,f.input,f.session)).draft;
  const composed=await composeFounderReconciliation(f.env,f.member,draft.id,draft.digest,f.session);expect(composed.report.rows[0]).toMatchObject({status:"matched_equal",crmMinor:"1000"});
  const hit=beforeStatement(f.env,"SELECT s.expiresAt AS session_expires FROM founder_reconciliation_reports","first",()=>{f.db.sqlite.prepare("UPDATE founder_stripe_read_grants SET state='revoked',ciphertext='' WHERE id=?").run(f.grant.id);});
  await expect(readFounderReconciliation(f.env,f.member,draft.id,f.session)).rejects.toThrow();expect(hit()).toBe(true);
 });
 it("does not revive original source authority after membership removal and re-add",async()=>{
  const f=await fixture(),draft=(await createFounderReconciliation(f.env,f.member,f.input,f.session)).draft;
  await composeFounderReconciliation(f.env,f.member,draft.id,draft.digest,f.session);
  f.db.sqlite.prepare("UPDATE team_workspace_memberships SET version=version+2 WHERE workspace_id=? AND user_id=?").run(f.member.workspaceId,f.member.userId);
  await expect(readFounderReconciliation(f.env,{...f.member,version:f.member.version+2},draft.id,f.session)).rejects.toThrow();
 });
 it("rejects a changed stored invoice even if its replacement report has a valid new digest",async()=>{
  const f=await fixture(),draft=(await createFounderReconciliation(f.env,f.member,f.input,f.session)).draft;
  const row=f.db.sqlite.prepare("SELECT report_json FROM founder_stripe_read_receipts WHERE id=?").get(f.receipt) as {report_json:string};const report=JSON.parse(row.report_json);report.capture.rows[0].amountPaid=900;const changed=JSON.stringify(report);
  f.db.sqlite.prepare("UPDATE founder_stripe_read_receipts SET report_json=?,result_digest=? WHERE id=?").run(changed,await stripeDigest(changed),f.receipt);
  await expect(composeFounderReconciliation(f.env,f.member,draft.id,draft.digest,f.session)).rejects.toThrow();
 });
});
