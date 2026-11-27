import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test" }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => auth.userId),
  resolveRequestIdentity: vi.fn(async () => ({ authorized: true, userId: auth.userId })),
}));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({ runs: [] }) }) }));

import { handleWorkspaceBilling } from "../src/workspace-billing-routes.js";
import {
  creditedMicroUsd, debitedMicroUsd, listLedgerEntries, readCreditState, recordRunDebit, syncPendingSpend, verifyStripeSignature, findTopUp,
} from "../src/workspace-billing.js";
import { personalBillingSubject } from "../src/billing-subject.js";

interface D1Runtime { getD1Database(name: string): Promise<D1Database>; dispose(): Promise<void> }
let runtime: D1Runtime;
let db: D1Database;

beforeAll(async () => {
  const require = createRequire(await realpath(new URL("../../../node_modules/wrangler/package.json", import.meta.url)));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare") as {
    Miniflare: new (options: unknown) => D1Runtime;
    convertV4MiniflareOptions(options: Record<string, unknown>): unknown;
  };
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default { fetch() { return new Response("fixture"); } }',
    compatibilityDate: "2026-06-01", host: "127.0.0.1", port: 0, inspectorPort: 0,
    cf: false, telemetry: { enabled: false }, d1Databases: ["AGENT_AUDIT"],
  }));
  db = await runtime.getD1Database("AGENT_AUDIT");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = (await readFile(new URL(name, migrations), "utf8")).replace(/^\s*--.*$/gm, "").replace(/\n/g, " ");
    await db.exec(sql);
  }
}, 60_000);
afterAll(async () => { await runtime?.dispose(); });

const WEBHOOK_SECRET = "whsec_test_secret";
const env = (overrides: Partial<Env> = {}) => ({
  AGENT_AUDIT: db, STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  INTERNAL_SIGNING_KEY: "ab".repeat(32), CodingOrchestrator: {}, ...overrides,
}) as unknown as Env;
const zeroMeter = () => ({ status: "not_applicable" as const, cpuSeconds: 0, ramGbSeconds: 0, diskGbSeconds: 0, costUsd: 0, provenance: null });
const run = (overrides: Partial<DelegatedRun>) => ({ runId: crypto.randomUUID(), status: "completed", createdAt: Date.now(), updatedAt: Date.now(), ...overrides }) as DelegatedRun;

async function sign(payload: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + payload)));
  return "t=" + timestamp + ",v1=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const dashboard = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) => new Request("https://shiba.example" + path, {
  ...init, headers: { origin: "https://shiba.example", "content-type": "application/json", ...headers, ...(init.headers ?? {}) },
});
async function webhook(event: unknown, signature?: string): Promise<Response> {
  const payload = JSON.stringify(event);
  return (await handleWorkspaceBilling(new Request("https://shiba.example/api/billing/stripe/webhook", {
    method: "POST", body: payload, headers: { "stripe-signature": signature ?? await sign(payload) },
  }), env()))!;
}
const paidSession = (id: string, subject: string | undefined, cents: number, extra: Record<string, unknown> = {}) => ({
  id: "evt_" + id,
  type: "checkout.session.completed",
  data: { object: { id, amount_total: cents, payment_status: "paid", payment_intent: "pi_" + id, customer: "cus_owner",
    metadata: { kind: "shiba_workspace_credits", ...(subject === undefined ? {} : { shiba_subject: subject, shiba_topup: "top_" + id }) }, ...extra } },
});
const refundEvent = (refundedCents: number) => ({
  id: "evt_refund", type: "charge.refunded",
  data: { object: { payment_intent: "pi_cs_refund", amount_refunded: refundedCents } },
});

async function seedAccount(subject: string, customerId: string | null, createdAt = 0) {
  await db.prepare("INSERT OR REPLACE INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, ?, ?)").bind(subject, customerId, createdAt).run();
}
async function seedPaidTopUp(subject: string, sessionId: string, microUsd: number) {
  await db.prepare("INSERT OR REPLACE INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id, stripe_payment_intent_id) VALUES (?, ?, ?, 'succeeded', 1, ?, ?, ?)")
    .bind(sessionId, subject, microUsd, "top_" + sessionId, sessionId, "pi_" + sessionId).run();
}

beforeEach(async () => {
  auth.userId = "owner@example.test";
  vi.unstubAllGlobals();
  for (const table of ["workspace_billing_pending", "workspace_billing_debits", "workspace_billing_topups", "workspace_billing_accounts"]) {
    await db.prepare("DELETE FROM " + table).run();
  }
});

describe("Stripe webhook signatures", () => {
  it("accepts a fresh v1 signature and rejects tampering, staleness and other secrets", async () => {
    const payload = "{\"id\":\"evt_1\"}";
    expect(await verifyStripeSignature(payload, await sign(payload), WEBHOOK_SECRET)).toBe(true);
    expect(await verifyStripeSignature(payload + " ", await sign(payload), WEBHOOK_SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, await sign(payload, Math.floor(Date.now() / 1000) - 3600), WEBHOOK_SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, await sign(payload), "whsec_other")).toBe(false);
    expect(await verifyStripeSignature(payload, null, WEBHOOK_SECRET)).toBe(false);
  });
});

describe("workspace credits", () => {
  it("buys credits through Checkout and settles them once from the signed webhook", async () => {
    const calls: { url: string; body: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
      if (url.endsWith("/customers")) return Response.json({ id: "cus_1" });
      if (url.endsWith("/checkout/sessions")) return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
      return Response.json({ id: "bps_1", url: "https://billing.stripe.com/p/session/1" });
    }));

    const before = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: { enabled: boolean; balanceUsd: number; exhausted: boolean } };
    expect(before.billing).toMatchObject({ enabled: true, balanceUsd: 0, exhausted: true });

    expect((await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 3 }) }), env()))!.status).toBe(400);
    const checkout = await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 25 }) }), env());
    expect(await checkout!.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const session = new URLSearchParams(calls.find((call) => call.url.endsWith("/checkout/sessions"))!.body);
    expect(session.get("customer")).toBe("cus_1");
    expect(session.get("line_items[0][price_data][unit_amount]")).toBe("2500");
    expect(session.get("metadata[shiba_subject]")).toBe("user:owner@example.test");
    expect(session.get("success_url")).toBe("https://shiba.example/analytics?billing=success");
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer sk_test_123")).toBe(true);

    expect((await webhook(paidSession("cs_test_1", undefined, 2500), "t=1,v1=bad")).status).toBe(400);
    expect(await (await webhook(paidSession("cs_test_1", "user:owner@example.test", 2500))).json()).toMatchObject({ settled: true });
    expect(await (await webhook(paidSession("cs_test_1", "user:owner@example.test", 2500))).json()).toMatchObject({ settled: false });

    // A finished run in history is not a debit: only the ledger can spend credits.
    await recordRunDebit(db, { subject: personalBillingSubject("owner@example.test").key, runId: "run_history", amountMicroUsd: 5_000_000 });
    const after = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: Record<string, unknown> };
    expect(after.billing).toMatchObject({ creditedUsd: 25, spentUsd: 5, pendingUsd: 0, balanceUsd: 20, exhausted: false, hasCustomer: true, mode: "test" });
    const topUps = after.billing.topUps as { id: string }[];
    expect(topUps[0]!.id.startsWith("top_")).toBe(true);
    expect(JSON.stringify(after)).not.toContain("cs_test_1");
    expect(JSON.stringify(after)).not.toContain("cus_1");
    expect(JSON.stringify(after)).not.toContain("sk_test");

    const portal = await handleWorkspaceBilling(dashboard("/api/billing/portal", { method: "POST", body: "{}" }), env());
    expect(await portal!.json()).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(new URLSearchParams(calls.at(-1)!.body).get("customer")).toBe("cus_1");
  });

  it("keeps a spent balance after run history is cleared", async () => {
    const subject = personalBillingSubject("clearer@example.test").key;
    await seedAccount(subject, null);
    await seedPaidTopUp(subject, "cs_c", 5_000_000);
    expect(await recordRunDebit(db, { subject, runId: "run-c", amountMicroUsd: 5_000_000 })).toBe(true);
    expect(await recordRunDebit(db, { subject, runId: "run-c", amountMicroUsd: 5_000_000 })).toBe(false);
    expect(await readCreditState(env(), subject, Date.now())).toMatchObject({ creditedUsd: 5, spentUsd: 5, balanceUsd: 0, exhausted: true });
    expect(await debitedMicroUsd(db, subject)).toBe(5_000_000);
    expect(await listLedgerEntries(db, subject)).toHaveLength(1);
  });

  it("counts the live cost of executing runs across the account", async () => {
    const subject = personalBillingSubject("running@example.test").key;
    await seedAccount(subject, null);
    await seedPaidTopUp(subject, "cs_r", 2_000_000);
    await syncPendingSpend(db, subject, [{ runId: "run-a", amountMicroUsd: 1_000_000 }, { runId: "run-b", amountMicroUsd: 500_000 }]);
    expect(await readCreditState(env(), subject, Date.now())).toMatchObject({ creditedUsd: 2, spentUsd: 0, pendingUsd: 1.5, balanceUsd: 0.5, exhausted: false });
  });

  it("reverses partial refunds to the same total in either order, once each", async () => {
    const subject = personalBillingSubject("owner@example.test").key;
    await seedAccount(subject, "cus_owner");
    await seedPaidTopUp(subject, "cs_refund", 10_000_000);
    expect(await creditedMicroUsd(db, subject)).toBe(10_000_000);
    expect(await findTopUp(db, { paymentIntentId: "pi_cs_refund" })).toMatchObject({ subject, amountMicroUsd: 10_000_000 });

    expect(await (await webhook(refundEvent(200))).json()).toMatchObject({ removedMicroUsd: 2_000_000 });
    expect(await (await webhook(refundEvent(200))).json()).toMatchObject({ removedMicroUsd: 0 });
    expect(await (await webhook(refundEvent(500))).json()).toMatchObject({ removedMicroUsd: 3_000_000 });
    expect(await creditedMicroUsd(db, subject)).toBe(5_000_000);

    // A late, lower running total is not a new refund.
    expect(await (await webhook(refundEvent(200))).json()).toMatchObject({ removedMicroUsd: 0 });
    expect(await creditedMicroUsd(db, subject)).toBe(5_000_000);
    expect((await listLedgerEntries(db, subject)).filter((entry) => entry.kind === "refund")).toHaveLength(2);
  });

  it("fully reverses a refunded payment and leaves the account exhausted", async () => {
    const subject = personalBillingSubject("reverse@example.test").key;
    await seedAccount(subject, "cus_reverse");
    await seedPaidTopUp(subject, "cs_refund", 10_000_000);
    expect(await (await webhook(refundEvent(1000))).json()).toMatchObject({ removedMicroUsd: 10_000_000 });
    expect(await creditedMicroUsd(db, subject)).toBe(0);
    expect((await readCreditState(env(), subject, Date.now())).exhausted).toBe(true);
  });

  it("acknowledges Stripe traffic that is not ours without retries", async () => {
    // Another product's checkout session, a paid session with no metadata, and a refund for an unknown payment.
    for (const event of [
      { id: "evt_f", type: "checkout.session.completed", data: { object: { id: "cs_foreign", amount_total: 900, payment_status: "paid", metadata: { kind: "other_product" } } } },
      { id: "evt_u", type: "checkout.session.completed", data: { object: { id: "cs_unknown", amount_total: 100, payment_status: "paid" } } },
      { id: "evt_r", type: "charge.refunded", data: { object: { payment_intent: "pi_unknown", amount_refunded: 500 } } },
    ]) {
      const response = await webhook(event);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ignored: true });
    }
  });

  it("recovers a paid session the Worker never stored when its customer is ours", async () => {
    await seedAccount("user:recovered@example.test", "cus_owner");
    const orphan = await webhook(paidSession("cs_orphan", "user:recovered@example.test", 1500));
    expect(orphan.status).toBe(200);
    expect(await orphan.json()).toMatchObject({ settled: true, reconciled: true });
    expect(await creditedMicroUsd(db, "user:recovered@example.test")).toBe(15_000_000);
    expect(await (await webhook(paidSession("cs_orphan", "user:recovered@example.test", 1500))).json()).toMatchObject({ settled: false });
  });

  it("refuses to credit a session whose customer is not the subject's", async () => {
    await seedAccount("user:foreign@example.test", "cus_someone_else");
    expect((await webhook(paidSession("cs_forged", "user:foreign@example.test", 1000))).status).toBe(500);
    expect(await creditedMicroUsd(db, "user:foreign@example.test")).toBe(0);
    expect((await webhook(paidSession("cs_stranger", "user:no_account@example.test", 1000))).status).toBe(500);
  });

  it("leaves unpaid and expired sessions uncredited", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_2" }) : Response.json({ id: "cs_async", url: "https://checkout.stripe.com/c/pay/cs_async" })));
    await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 10 }) }), env());
    await webhook(paidSession("cs_async", "user:owner@example.test", 1000, { payment_status: "unpaid" }));
    await webhook({ id: "evt_exp", type: "checkout.session.expired", data: { object: { id: "cs_async", metadata: { kind: "shiba_workspace_credits", shiba_subject: "user:owner@example.test" } } } });
    expect(await creditedMicroUsd(db, personalBillingSubject("owner@example.test").key)).toBe(0);
    const { billing } = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: { topUps: { status: string }[] } };
    expect(billing.topUps[0]?.status).toBe("expired");
  });

  it("is off, and never blocks, until both Stripe secrets are set", async () => {
    const response = await handleWorkspaceBilling(dashboard("/api/billing"), env({ STRIPE_WEBHOOK_SECRET: "" }));
    expect(await response!.json()).toMatchObject({ billing: { enabled: false, missing: ["STRIPE_WEBHOOK_SECRET"], exhausted: false } });
    expect((await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 10 }) }), env({ STRIPE_SECRET_KEY: "" })))!.status).toBe(503);
  });

  it("refuses cross-origin mutations", async () => {
    const response = await handleWorkspaceBilling(new Request("https://shiba.example/api/billing/checkout", {
      method: "POST", body: JSON.stringify({ amountUsd: 10 }), headers: { origin: "https://evil.example", "content-type": "application/json" },
    }), env());
    expect(response!.status).toBe(403);
  });
});

describe("team workspace credits", () => {
  const workspaceId = "ws_0123456789abcdef01234567";
  async function addMember(userId: string, role: string) {
    await db.prepare("INSERT OR IGNORE INTO team_workspaces (tenant_id, workspace_id, name, version, created_at) VALUES ('self-hosted', ?, 'Acme', 1, 1)").bind(workspaceId).run();
    await db.prepare("INSERT OR REPLACE INTO team_workspace_memberships (tenant_id, workspace_id, user_id, role, status, version, joined_at) VALUES ('self-hosted', ?, ?, ?, 'active', 1, 1)")
      .bind(workspaceId, userId, role).run();
  }

  it("funds a team workspace and lets only owners or admins buy for it", async () => {
    await addMember("owner@example.test", "owner");
    await addMember("member@example.test", "member");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_team" }) : Response.json({ id: "cs_team", url: "https://checkout.stripe.com/c/pay/cs_team" })));

    const status = await handleWorkspaceBilling(dashboard("/api/billing?workspace=" + workspaceId), env());
    expect(await status!.json()).toMatchObject({ billing: { enabled: true, exhausted: true } });

    auth.userId = "member@example.test";
    expect((await handleWorkspaceBilling(dashboard("/api/billing/checkout?workspace=" + workspaceId, { method: "POST", body: JSON.stringify({ amountUsd: 50 }) }), env()))!.status).toBe(403);
    auth.userId = "stranger@example.test";
    expect((await handleWorkspaceBilling(dashboard("/api/billing?workspace=" + workspaceId), env()))!.status).toBe(403);
    auth.userId = "owner@example.test";
    const checkout = await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 50 }) }, { "X-Shiba-Workspace": workspaceId }), env());
    expect(await checkout!.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_team" });
    const checkoutBody = new URLSearchParams(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => String(input).endsWith("/checkout/sessions"))?.[1]?.body));
    expect(checkoutBody.get("success_url")).toBe(`https://shiba.example/settings/?section=team&teamTab=settings&billing=success`);

    await webhook(paidSession("cs_team", "team:" + workspaceId, 5000));
    expect(await creditedMicroUsd(db, "team:" + workspaceId)).toBe(50_000_000);
  });
});

describe("ledger edges", () => {
  it("ignores in-flight cost older than the time limit", async () => {
    const subject = personalBillingSubject("stale@example.test").key;
    await seedAccount(subject, null);
    await seedPaidTopUp(subject, "cs_stale", 1_000_000);
    const now = Date.now();
    await db.prepare("INSERT INTO workspace_billing_pending (subject, run_id, amount_micro_usd, updated_at) VALUES (?, ?, ?, ?)")
      .bind(subject, "run-gone", 5_000_000, now - 8_000_000).run();
    await db.prepare("INSERT INTO workspace_billing_pending (subject, run_id, amount_micro_usd, updated_at) VALUES (?, ?, ?, ?)")
      .bind(subject, "run-live", 200_000, now).run();
    expect(await readCreditState(env(), subject, now)).toMatchObject({ balanceUsd: 0.8, exhausted: false });
    await db.prepare("DELETE FROM workspace_billing_pending").run();
  });

  it("matches a payment id literally, not through LIKE wildcards", async () => {
    const subject = personalBillingSubject("wildcard@example.test").key;
    await seedAccount(subject, "cus_wildcard");
    await seedPaidTopUp(subject, "cs_refund", 2_000_000);
    // A neighbouring id that an unescaped '_' would also match.
    await db.prepare("INSERT INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id, stripe_payment_intent_id) VALUES ('cs_other', ?, 4000000, 'succeeded', 1, 'top_other', 'cs_other', 'pics_refund')")
      .bind(subject).run();
    const refund = { id: "evt_r", type: "charge.refunded", data: { object: { payment_intent: "pi_cs_refund", amount_refunded: 200 } } };
    expect(await (await webhook(refund)).json()).toMatchObject({ removedMicroUsd: 2_000_000 });
    expect(await creditedMicroUsd(db, subject)).toBe(4_000_000);
    // The neighbouring payment is untouched by that refund.
    const other = { id: "evt_r2", type: "charge.refunded", data: { object: { payment_intent: "pics_refund", amount_refunded: 100 } } };
    expect(await (await webhook(other)).json()).toMatchObject({ removedMicroUsd: 1_000_000 });
    expect(await creditedMicroUsd(db, subject)).toBe(3_000_000);
  });

  it("answers a logged 500 when our session arrives without a subject", async () => {
    const response = await webhook({ id: "evt_ns", type: "checkout.session.completed", data: { object: {
      id: "cs_no_subject", amount_total: 500, payment_status: "paid", customer: "cus_owner", metadata: { kind: "shiba_workspace_credits" } } } });
    expect(response.status).toBe(500);
  });
});
