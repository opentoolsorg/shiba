import { afterEach,describe,it,expect,vi } from "vitest";
import { sha256Json as stripeDigest,sha256Json as hubspotDigest,type FounderReadsEnv as StripeEnv } from "../src/founder/reads/index.js";
import { seedFounderRead } from "./fixtures/founder-read.js";
import { loadReconciliationSources } from "../src/founder-reconciliation-sources.js";
const source=vi.hoisted(()=>({authority:null as unknown,expiresAt:Date.now()+86400000}));
import { createFounderReconciliation,composeFounderReconciliation,readFounderReconciliation } from "../src/founder-reconciliation-store.js";
vi.mock("../src/founder-auto-read-store.js",async original=>({...await original<typeof import("../src/founder-auto-read-store.js")>(),automaticAvailability:()=>null}));
import { handleFounderReconciliations } from "../src/founder-reconciliation-routes.js";
vi.mock("../src/request-auth.js",async original=>({...await original<typeof import("../src/request-auth.js")>(),isAuthorizedRequest:async()=>true,resolveUserId:async()=>"fixture@example.test"}));
vi.mock("@shiba/auth/better-auth",async original=>({...await original<typeof import("@shiba/auth/better-auth")>(),resolveBetterAuthSessionAccount:async()=>({policy:{accountId:"native-fixture",email:"fixture@example.test",kind:"invited"},emailVerified:true,sessionId:"fixture-session",sessionExpiresAt:source.expiresAt})}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
// Both source grants and their receipts come from the read-grant module's interface (draft, verify, enable, tick against a stubbed provider).
async function fixture(){
 const expires=Date.now()+600000,identity={email:"fixture@example.test",account:"native-fixture",sessionId:"fixture-session"};
 const hubSeed=await seedFounderRead("hubspot",{identity,sessionExpiresAt:expires,maxCalls:2,draft:{expiresAt:expires,selection:{dealIds:["1","2"],invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency"}},readBody:{status:"COMPLETE",results:[{id:"1",properties:{invoice_id:"in_A",paid_amount:"10.00",currency:"USD"}}]}});
 const stripeSeed=await seedFounderRead("stripe",{on:hubSeed,maxCalls:2,draft:{expiresAt:expires,selection:{kind:"invoices",createdGte:100,createdLt:200,limit:5}},readBody:{object:"list",has_more:false,data:[{id:"in_A",object:"invoice",created:150,currency:"usd",amount_paid:1000,status:"paid",livemode:false}]}});
 vi.unstubAllGlobals();
 const {env,member}=hubSeed,db={sqlite:hubSeed.db,database:env.AGENT_AUDIT};db.sqlite.exec('CREATE TABLE hub_fixture(current INTEGER);INSERT INTO hub_fixture VALUES(1)');
 const hub={id:hubSeed.grantId},hubReceipt=hubSeed.receiptId,grant={id:stripeSeed.grantId},receipt=stripeSeed.receiptId;
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
 it.each(["non-digit deal id","duplicate deal id","too many records"]) ("rejects HubSpot evidence with %s",async(kind)=>{
  const f=await fixture();const receipt=f.db.sqlite.prepare("SELECT id,report_json FROM founder_hubspot_read_receipts WHERE state='completed'").get() as {id:string;report_json:string};
  const report=JSON.parse(receipt.report_json);const first=report.capture.records[0];report.capture.records=kind==="non-digit deal id"?[{...first,dealId:"x"}]:kind==="duplicate deal id"?[first,{...first}]:[first,{...first,dealId:"2"},{...first,dealId:"3"}];const changed=JSON.stringify(report);
  f.db.sqlite.prepare("UPDATE founder_hubspot_read_receipts SET report_json=?,result_digest=? WHERE id=?").run(changed,await hubspotDigest(changed),receipt.id);
  await expect(loadReconciliationSources(f.env,f.member,f.input)).rejects.toThrow();
 });
 it("rejects HubSpot evidence whose capture selection differs from the pinned selection",async()=>{
  const f=await fixture();const receipt=f.db.sqlite.prepare("SELECT id,report_json FROM founder_hubspot_read_receipts WHERE state='completed'").get() as {id:string;report_json:string};
  const report=JSON.parse(receipt.report_json);report.capture.selection={dealIds:["999"],invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency"};const changed=JSON.stringify(report);
  f.db.sqlite.prepare("UPDATE founder_hubspot_read_receipts SET report_json=?,result_digest=? WHERE id=?").run(changed,await hubspotDigest(changed),receipt.id);
  await expect(loadReconciliationSources(f.env,f.member,f.input)).rejects.toThrow();
 });
});
