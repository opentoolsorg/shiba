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
const store = vi.hoisted(() => ({ runs: [] as unknown[] }));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => Response.json({ runs: store.runs }) }),
}));

import { handleWorkspaceBilling } from "../src/workspace-billing-routes.js";
import {
  creditedMicroUsd, debitedMicroUsd, listLedgerEntries, readCreditState, recordRunDebit, verifyStripeSignature, findTopUp,
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
const paidSession = (id: string, subject: string | undefined, cents: number, payment_status = "paid") => ({
  id: "evt_" + id,
  type: "checkout.session.completed",
  data: { object: { id, amount_total: cents, payment_status, payment_intent: "pi_" + id,
    metadata: { kind: "shiba_workspace_credits", ...(subject === undefined ? {} : { shiba_subject: subject, shiba_topup: "top_" + id }) } } },
});

beforeEach(async () => {
  store.runs = [];
  auth.userId = "owner@example.test";
  vi.unstubAllGlobals();
  for (const table of ["workspace_billing_debits", "workspace_billing_topups", "workspace_billing_accounts"]) {
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
    store.runs = [run({ runId: "run_history", queuedBy: "owner@example.test", usage: { costUsd: 5 } })];
    const unspent = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: Record<string, unknown> };
    expect(unspent.billing).toMatchObject({ creditedUsd: 25, spentUsd: 0, balanceUsd: 25 });
    await recordRunDebit(db, { subject: personalBillingSubject("owner@example.test").key, runId: "run_history", amountMicroUsd: 5_000_000 });
    const after = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: Record<string, unknown> };
    expect(after.billing).toMatchObject({ creditedUsd: 25, spentUsd: 5, balanceUsd: 20, exhausted: false, hasCustomer: true, mode: "test" });
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
    await creditedMicroUsd(db, subject);
    await db.prepare("INSERT INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(subject, 0).run();
    await db.prepare("INSERT INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id) VALUES ('cs_c', ?, 5000000, 'succeeded', 1, 'top_c', 'cs_c')").bind(subject).run();
    const charged = run({ runId: "run-c", queuedBy: "clearer@example.test", createdAt: 10, usage: { costUsd: 5 } });
    expect(await recordRunDebit(db, { subject, runId: charged.runId, amountMicroUsd: 5_000_000 })).toBe(true);
    expect(await recordRunDebit(db, { subject, runId: charged.runId, amountMicroUsd: 5_000_000 })).toBe(false);
    const spent = await readCreditState(env(), subject, [], Date.now(), zeroMeter);
    expect(spent).toMatchObject({ creditedUsd: 5, spentUsd: 5, balanceUsd: 0, exhausted: true });
    const reused = run({ runId: "run-c", queuedBy: "clearer@example.test", createdAt: 10, usage: { costUsd: 5 } });
    expect((await readCreditState(env(), subject, [reused], Date.now(), zeroMeter)).spentUsd).toBe(5);
    expect(await debitedMicroUsd(db, subject)).toBe(5_000_000);
    expect((await ledgerCount(subject))).toBe(1);
  });

  it("counts the live cost of running work against the balance", async () => {
    const subject = personalBillingSubject("running@example.test").key;
    await db.prepare("INSERT INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(subject, 0).run();
    await db.prepare("INSERT INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id) VALUES ('cs_r', ?, 2000000, 'succeeded', 1, 'top_r', 'cs_r')").bind(subject).run();
    const meter = () => ({ ...zeroMeter(), costUsd: 1.5 });
    const active = run({ runId: "run-r", queuedBy: "running@example.test", createdAt: 5, status: "running" });
    const state = await readCreditState(env(), subject, [active], Date.now(), meter);
    expect(state).toMatchObject({ creditedUsd: 2, spentUsd: 0, pendingUsd: 1.5, balanceUsd: 0.5, exhausted: false });
  });

  it("reverses credits on a Stripe refund, once", async () => {
    store.runs = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_refund" }) : Response.json({ id: "cs_refund", url: "https://checkout.stripe.com/c/pay/cs_refund" })));
    await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 10 }) }), env());
    await webhook(paidSession("cs_refund", "user:owner@example.test", 1000));
    const subject = personalBillingSubject("owner@example.test").key;
    expect(await creditedMicroUsd(db, subject)).toBe(10_000_000);
    expect(await findTopUp(db, { paymentIntentId: "pi_cs_refund" })).toMatchObject({ subject, amountMicroUsd: 10_000_000 });

    const refund = (refundId: string) => ({ id: "evt_refund", type: "charge.refunded", data: { object: {
      payment_intent: "pi_cs_refund", amount_refunded: 1000, refunds: { data: [{ id: refundId, amount: 1000 }] } } } });
    expect(await (await webhook(refund("re_1"))).json()).toMatchObject({ applied: true });
    expect(await (await webhook(refund("re_1"))).json()).toMatchObject({ applied: false });
    expect(await creditedMicroUsd(db, subject)).toBe(0);
    expect((await readCreditState(env(), subject, [], Date.now(), zeroMeter)).exhausted).toBe(true);
  });

  it("records a paid session the Worker never stored instead of dropping it", async () => {
    const orphan = await webhook(paidSession("cs_orphan", "user:recovered@example.test", 1500));
    expect(orphan.status).toBe(200);
    expect(await orphan.json()).toMatchObject({ settled: true, reconciled: true });
    expect(await creditedMicroUsd(db, personalBillingSubject("recovered@example.test").key)).toBe(15_000_000);
    expect(await (await webhook(paidSession("cs_orphan", "user:recovered@example.test", 1500))).json()).toMatchObject({ settled: false });
  });

  it("refuses and reports a paid session it cannot attribute", async () => {
    const anonymous = await webhook(paidSession("cs_anon", undefined, 1000));
    expect(anonymous.status).toBe(500);
    expect((await webhook({ id: "evt_x", type: "charge.refunded", data: { object: { payment_intent: "pi_unknown", amount_refunded: 500 } } })).status).toBe(500);
  });

  it("leaves unpaid and expired sessions uncredited", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_2" }) : Response.json({ id: "cs_async", url: "https://checkout.stripe.com/c/pay/cs_async" })));
    await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 10 }) }), env());
    await webhook(paidSession("cs_async", "user:owner@example.test", 1000, "unpaid"));
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
    await db.prepare("INSERT OR IGNORE INTO team_workspaces (tenant_id, workspace_id, name, version, created_at) VALUES ('self-hosted', ?, 'Acme', 1, 1)")
      .bind(workspaceId).run();
    await db.prepare("INSERT OR REPLACE INTO team_workspace_memberships (tenant_id, workspace_id, user_id, role, status, version, joined_at) VALUES ('self-hosted', ?, ?, ?, 'active', 1, 1)")
      .bind(workspaceId, userId, role).run();
  }

  it("funds a team workspace and lets only owners or admins buy for it", async () => {
    await addMember("owner@example.test", "owner");
    await addMember("member@example.test", "member");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_team" }) : Response.json({ id: "cs_team", url: "https://checkout.stripe.com/c/pay/cs_team" })));

    const status = await handleWorkspaceBilling(dashboard(`/api/billing?workspace=${workspaceId}`), env());
    expect(await status!.json()).toMatchObject({ billing: { enabled: true, exhausted: true } });

    auth.userId = "member@example.test";
    expect((await handleWorkspaceBilling(dashboard(`/api/billing/checkout?workspace=${workspaceId}`, { method: "POST", body: JSON.stringify({ amountUsd: 50 }) }), env()))!.status).toBe(403);
    auth.userId = "stranger@example.test";
    expect((await handleWorkspaceBilling(dashboard(`/api/billing?workspace=${workspaceId}`), env()))!.status).toBe(403);
    auth.userId = "owner@example.test";
    const checkout = await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 50 }) }, { "X-Shiba-Workspace": workspaceId }), env());
    expect(await checkout!.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_team" });
    expect(await creditedMicroUsdAfterTeamBuy()).toBe(0);

    await webhook(paidSession("cs_team", `team:${workspaceId}`, 5000));
    expect(await creditedMicroUsd(db, `team:${workspaceId}`)).toBe(50_000_000);
  });

  it("bills team runs to the workspace, not the executor's user", async () => {
    const subject = `team:${workspaceId}`;
    await db.prepare("INSERT INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(subject, 0).run();
    await db.prepare("INSERT INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id) VALUES ('cs_t', ?, 1000000, 'succeeded', 1, 'top_t', 'cs_t')").bind(subject).run();
    const teamRun = run({ queuedBy: "member@example.test", orgId: `team:${workspaceId}`, status: "running", usage: { costUsd: 0.25 } });
    const personalRun = run({ queuedBy: "member@example.test", orgId: "self-hosted", status: "running", usage: { costUsd: 0.75 } });
    const teamState = await readCreditState(env(), subject, [teamRun, personalRun], Date.now(), zeroMeter);
    expect(teamState.spentUsd).toBe(0);
    const personalSubject = personalBillingSubject("member@example.test").key;
    await db.prepare("INSERT OR IGNORE INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(personalSubject, 0).run();
    const personal = await readCreditState(env(), personalSubject, [teamRun, personalRun], Date.now(), zeroMeter);
    expect(personal.pendingUsd).toBe(0.75);
    expect(teamState).toMatchObject({ creditedUsd: 1, exhausted: false });
  });
});

async function ledgerCount(subject: string): Promise<number> {
  return (await listLedgerEntries(db, subject)).length;
}
async function creditedMicroUsdAfterTeamBuy(): Promise<number> {
  return creditedMicroUsd(db, "team:ws_0123456789abcdef01234567");
}
