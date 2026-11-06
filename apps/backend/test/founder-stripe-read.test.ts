import { describe, expect, it } from "vitest";
import { founderStripeReadUrl, projectFounderStripeRead, summarizeFounderStripeBalance, type StripeBalanceRow } from "../src/founder-stripe-read.js";
const selection = { kind: "balance_transactions" as const, createdGte: 100, createdLt: 200, limit: 2 };
const row = { id: "txn_abc", object: "balance_transaction", created: 150, currency: "usd", amount: 1000, fee: 30, net: 970, type: "charge", source: "ch_abc", customer_email: "private@example.test" };
describe("bounded Stripe report primitives", () => {
 it("constructs a fixed URL and projects only selected fields", () => { const url = new URL(founderStripeReadUrl(selection)); expect(url.origin).toBe("https://api.stripe.com"); expect(url.pathname).toBe("/v1/balance_transactions"); expect(url.searchParams.get("created[lt]")).toBe("200"); const capture = projectFounderStripeRead(selection, { object: "list", has_more: true, data: [row] }, "test"); expect(JSON.stringify(capture)).not.toContain("private@example.test"); expect(capture).toMatchObject({hasMore:true,datasetCompleteness:"unknown",businessSuccess:"unverified"}); });
 it("rejects invalid windows, duplicate rows, bad accounting and out-of-range records", () => { expect(() => founderStripeReadUrl({...selection,createdLt:100})).toThrow(); expect(() => projectFounderStripeRead(selection,{object:"list",has_more:false,data:[row,row]},"test")).toThrow(); expect(() => projectFounderStripeRead(selection,{object:"list",has_more:false,data:[{...row,net:971}]},"test")).toThrow(); expect(() => projectFounderStripeRead(selection,{object:"list",has_more:false,data:[{...row,created:200}]},"test")).toThrow(); });
 it("checks invoice mode and does not retain customer identity", () => { const invoice={id:"in_abc",object:"invoice",created:150,currency:"eur",amount_paid:40,status:"paid",livemode:false,customer_email:"private@example.test"}; const page={object:"list",has_more:false,data:[invoice]}; const s={...selection,kind:"invoices" as const}; expect(() => projectFounderStripeRead(s,page,"live")).toThrow(); expect(JSON.stringify(projectFounderStripeRead(s,page,"test"))).not.toContain("private@example.test"); });
 it("sums captured minor units deterministically by currency with arbitrary precision", () => {const a={...row,amount:Number.MAX_SAFE_INTEGER,fee:0,net:Number.MAX_SAFE_INTEGER} as StripeBalanceRow,b={...a,id:"txn_def"},c={...row,id:"txn_ghi",currency:"eur"} as StripeBalanceRow;expect(summarizeFounderStripeBalance([a,c,b])).toEqual([{currency:"eur",count:1,amountMinor:"1000",feeMinor:"30",netMinor:"970"},{currency:"usd",count:2,amountMinor:"18014398509481982",feeMinor:"0",netMinor:"18014398509481982"}]);expect(() => summarizeFounderStripeBalance([a,a])).toThrow();});
});

import { sealFounderStripeCredential, openFounderStripeCredential } from "../src/founder-stripe-credential.js";
describe("Stripe-only credential cryptography", () => {
 it("binds encrypted key to the exact owner, account, revision, mode and expiry", async () => {
  const scope={workspaceId:`ws_${"a".repeat(24)}`,ownerAccountId:"native-owner",credentialId:`fsc_${"b".repeat(32)}`,revision:1,accountId:"acct_Fixture",mode:"test" as const,expiresAt:2000000000000}, secret="ab".repeat(32), value=`rk_test_${"F".repeat(24)}`;
  const sealed=await sealFounderStripeCredential(value,secret,scope); expect(sealed.ciphertext).not.toContain(value); expect(sealed.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(await openFounderStripeCredential(sealed.ciphertext,secret,scope)).toBe(value);
  for(const change of [{revision:2},{ownerAccountId:"other"},{accountId:"acct_Other"},{expiresAt:2000000000001}]) await expect(openFounderStripeCredential(sealed.ciphertext,secret,{...scope,...change})).rejects.toThrow();
  await expect(sealFounderStripeCredential(`sk_test_${"F".repeat(24)}`,secret,scope)).rejects.toThrow(); await expect(sealFounderStripeCredential(value,"bad",scope)).rejects.toThrow();
 });
});

import { execFileSync } from "node:child_process";
it("keeps the Stripe executor pin synchronized with all executable lane sources",()=>{execFileSync(process.execPath,[new URL("../src/founder-stripe-manifest.mjs",import.meta.url).pathname,"--check"]);});
