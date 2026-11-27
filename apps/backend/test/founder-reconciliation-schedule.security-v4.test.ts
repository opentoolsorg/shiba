import { afterEach,describe,it,expect,vi } from "vitest";
import { seedFounderRead } from "./fixtures/founder-read.js";
import type { FounderReadsEnv as StripeEnv,FounderReadsEnv as HubSpotEnv } from "../src/founder/reads/index.js";
import { createFounderReconciliation,composeFounderReconciliation } from "../src/founder-reconciliation-store.js";
import { createReconciliationSchedule,enableReconciliationSchedule,type ReconciliationScheduleEnv } from "../src/founder-reconciliation-schedule-store.js";
import { tickFounderReconciliationSchedules } from "../src/founder-reconciliation-schedule-runtime.js";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
// Both source grants are seeded through the read-grant module's interface (draft, verify, enable, tick against a stubbed provider).
async function fixture(){vi.useFakeTimers({toFake:["Date"]});const expires=Date.now()+7*86400000,identity={email:"schedule-owner@example.test",account:"native-owner",sessionId:"fixture-session"};
 const hubSeed=await seedFounderRead("hubspot",{identity,sessionExpiresAt:expires,env:{FOUNDER_RECONCILIATION_SCHEDULES_ENABLED:"true"},maxCalls:5,draft:{expiresAt:expires,selection:{dealIds:["11","22"],invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency"}},readBody:{status:"COMPLETE",results:[{id:"11",properties:{invoice_id:"in_A",paid_amount:"10.00",currency:"USD"}}]}});
 const stripeSeed=await seedFounderRead("stripe",{on:hubSeed,maxCalls:5,draft:{expiresAt:expires,selection:{kind:"invoices",createdGte:100,createdLt:200,limit:5}},readBody:{object:"list",has_more:false,data:[{id:"in_A",object:"invoice",created:150,currency:"usd",amount_paid:1000,status:"paid",livemode:false}]}});
 const env=hubSeed.env as unknown as StripeEnv & HubSpotEnv & ReconciliationScheduleEnv,{member,fetcher}=hubSeed,session={id:hubSeed.sessionId,expiresAt:expires},db={sqlite:hubSeed.db,database:env.AGENT_AUDIT},hub={id:hubSeed.grantId},stripe={id:stripeSeed.grantId},hubReceipt=hubSeed.receiptId,stripeReceipt=stripeSeed.receiptId;
 db.sqlite.function("julianday",(_v:unknown)=>2440587.5+Date.now()/86400000);
 let maxParameters=0;const originalPrepare=db.database.prepare.bind(db.database);db.database.prepare=(sql)=>{const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({...statement,bind:(...values:unknown[])=>{maxParameters=Math.max(maxParameters,values.length);if(values.length>100)throw Error("D1 parameter limit exceeded");return wrap(statement.bind(...values));}} as D1PreparedStatement);return wrap(originalPrepare(sql));};
 const capture=async()=>{await hubSeed.tick();await stripeSeed.tick();};
 const input={hubspot:{grantId:hub.id,grantVersion:1,occurrenceId:hubReceipt,sourceOrdinal:0 as const},stripe:{grantId:stripe.id,receiptId:stripeReceipt},mapping:{invoiceIdProperty:"invoice_id",paidAmountProperty:"paid_amount",currencyProperty:"currency",amountUnit:"major-decimal" as const,basisAttestation:"crm-property-represents-stripe-invoice-amount-paid" as const},expiresAt:Date.now()+1800000},one=await createFounderReconciliation(env,member,input,session);await composeFounderReconciliation(env,member,one.draft.id,one.draft.digest,session);const draft=await createReconciliationSchedule(env,member,{comparisonId:one.draft.id,expiresAt:expires-1000,maxComparisons:2,maxSkewMinutes:5},session);return{db,env,member,session,draft:draft.schedule,hub,stripe,fetcher,capture,get maxParameters(){return maxParameters;}};}

describe("independent standing comparison cadence",()=>{
 it("cannot let an older no-pair tick shorten the next successful-result cadence",async()=>{
  const f=await fixture();await enableReconciliationSchedule(f.env,f.member,f.draft.id,f.draft.digest,f.session);vi.setSystemTime(Date.now()+5000);
  const original=f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);let interleaved=false,committedDue=0;
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
   if(key==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
   if(key==="run")return async()=>{if(!interleaved&&sql.includes("UPDATE founder_reconciliation_schedules SET next_due_at=?")){interleaved=true;await f.capture();expect((await tickFounderReconciliationSchedules(f.env)).completed).toBe(1);committedDue=(f.db.sqlite.prepare("SELECT next_due_at FROM founder_reconciliation_schedules").get() as {next_due_at:number}).next_due_at;}return target.run();};
   const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});f.env.AGENT_AUDIT.prepare=sql=>wrap(original(sql),sql);
  await tickFounderReconciliationSchedules(f.env);expect(interleaved).toBe(true);
  expect((f.db.sqlite.prepare("SELECT next_due_at FROM founder_reconciliation_schedules").get() as {next_due_at:number}).next_due_at).toBe(committedDue);
 });
});
