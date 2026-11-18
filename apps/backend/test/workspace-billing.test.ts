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
}));
const store = vi.hoisted(() => ({ runs: [] as unknown[] }));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => Response.json({ runs: store.runs }) }),
}));

import { handleWorkspaceBilling } from "../src/workspace-billing-routes.js";
import { readCreditState, verifyStripeSignature, workspaceCreditSpendUsd } from "../src/workspace-billing.js";

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

const dashboard = (path: string, init: RequestInit = {}) => new Request("https://shiba.example" + path, {
  ...init, headers: { origin: "https://shiba.example", "content-type": "application/json", ...(init.headers ?? {}) },
});
async function webhook(event: unknown, signature?: string): Promise<Response> {
  const payload = JSON.stringify(event);
  return (await handleWorkspaceBilling(new Request("https://shiba.example/api/billing/stripe/webhook", {
    method: "POST", body: payload, headers: { "stripe-signature": signature ?? await sign(payload) },
  }), env()))!;
}
const completed = (id: string, owner: string, cents: number, payment_status = "paid") => ({
  type: "checkout.session.completed",
  data: { object: { id, amount_total: cents, payment_status, payment_intent: "pi_" + id, metadata: { kind: "shiba_workspace_credits", shiba_owner: owner } } },
});

beforeEach(() => { store.runs = []; vi.unstubAllGlobals(); });

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
  it("charges compute always and model spend only when the deployment paid for it", () => {
    const meter = () => ({ ...zeroMeter(), costUsd: 0.5 });
    const runs = [
      run({ usage: { costUsd: 2 } }),
      run({ usage: { costUsd: 3 }, authAccount: "plan" }),
      run({ usage: { costUsd: 4 }, createdAt: 0 }),
    ];
    expect(workspaceCreditSpendUsd(runs, 1, Date.now(), meter)).toBe(3);
  });

  it("buys credits through Checkout and settles them once from the signed webhook", async () => {
    auth.userId = "buyer@example.test";
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
    expect(session.get("metadata[shiba_owner]")).toBe("buyer@example.test");
    expect(session.get("success_url")).toBe("https://shiba.example/analytics?billing=success");
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer sk_test_123")).toBe(true);

    expect((await webhook(completed("cs_test_1", "buyer@example.test", 2500), "t=1,v1=bad")).status).toBe(400);
    expect(await (await webhook(completed("cs_test_1", "intruder@example.test", 2500))).json()).toMatchObject({ settled: false });
    expect(await (await webhook(completed("cs_test_1", "buyer@example.test", 999_999))).json()).toMatchObject({ settled: false });
    expect(await (await webhook(completed("cs_test_1", "buyer@example.test", 2500))).json()).toMatchObject({ settled: true });
    expect(await (await webhook(completed("cs_test_1", "buyer@example.test", 2500))).json()).toMatchObject({ settled: false });

    store.runs = [run({ usage: { costUsd: 5 } })];
    const after = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: Record<string, unknown> };
    expect(after.billing).toMatchObject({ creditedUsd: 25, spentUsd: 5, balanceUsd: 20, exhausted: false, hasCustomer: true, mode: "test" });
    expect(JSON.stringify(after)).not.toContain("cus_1");
    expect(JSON.stringify(after)).not.toContain("sk_test");

    const portal = await handleWorkspaceBilling(dashboard("/api/billing/portal", { method: "POST", body: "{}" }), env());
    expect(await portal!.json()).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(new URLSearchParams(calls.at(-1)!.body).get("customer")).toBe("cus_1");
  });

  it("leaves unpaid and expired sessions uncredited", async () => {
    auth.userId = "async@example.test";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/customers")
      ? Response.json({ id: "cus_2" }) : Response.json({ id: "cs_async", url: "https://checkout.stripe.com/c/pay/cs_async" })));
    await handleWorkspaceBilling(dashboard("/api/billing/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 10 }) }), env());
    await webhook(completed("cs_async", "async@example.test", 1000, "unpaid"));
    await webhook({ type: "checkout.session.expired", data: { object: { id: "cs_async", metadata: { kind: "shiba_workspace_credits", shiba_owner: "async@example.test" } } } });
    const state = await readCreditState(env(), "async@example.test", [], Date.now(), zeroMeter);
    expect(state.creditedUsd).toBe(0);
    const { billing } = await (await handleWorkspaceBilling(dashboard("/api/billing"), env()))!.json() as { billing: { topUps: { status: string }[] } };
    expect(billing.topUps[0]?.status).toBe("expired");
  });

  it("is off, and never blocks, until both Stripe secrets are set", async () => {
    auth.userId = "nobilling@example.test";
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
