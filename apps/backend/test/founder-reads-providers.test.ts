import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { founderStripeReportSchema } from "@shiba/shared";
import { seedFounderRead, type FounderReadSeed } from "./fixtures/founder-read.js";

/**
 * What is genuinely different per provider: the requests it sends, the drafts it refuses, and how it projects
 * (or refuses to project) a provider page into the stored report. Everything is observed through the module's
 * interface: the stubbed `fetch` sees the request, and the stored receipt is the projection.
 */
type Call = { url: URL; method?: string; headers: Record<string, string>; body?: string; redirect?: string };
const calls = (seed: FounderReadSeed): Call[] => seed.fetcher.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), method: (init as RequestInit).method, headers: (init as RequestInit).headers as Record<string, string>, body: (init as RequestInit).body as string | undefined, redirect: (init as RequestInit).redirect }));
const report = (seed: FounderReadSeed) => JSON.parse(seed.receipts()[0]!.report_json!) as Record<string, any>;

/** Ticks an enabled grant against one provider page and returns the stored outcome. */
async function capture(seed: FounderReadSeed, page: unknown) {
  seed.respond("read", () => Response.json(page));
  await seed.tick();
  const [receipt] = seed.receipts();
  return { state: receipt!.state, json: receipt!.report_json, grant: seed.grant().state };
}
const refused = { state: "unknown", json: null, grant: "blocked" };
const draftStatus = async (seed: FounderReadSeed, overrides: Record<string, unknown>, token?: string) => (await seed.call("POST", "", seed.draftBody(overrides, token)))?.status;
const pinInSync = (manifest: string) => { execFileSync(process.execPath, [new URL(`../src/${manifest}`, import.meta.url).pathname, "--check"]); };

describe("stripe", () => {
  const selection = { kind: "balance_transactions", createdGte: 100, createdLt: 200, limit: 2 };
  const row = { id: "txn_abc", object: "balance_transaction", created: 150, currency: "usd", amount: 1000, fee: 30, net: 970, type: "charge", source: "ch_abc", customer_email: "private@example.test", private: "discard" };
  const page = (data: unknown[], more = false) => ({ object: "list", has_more: more, url: "https://private.test", data });

  it("verifies against the fixed account URL and reads the fixed, bounded list URL", async () => {
    const seed = await seedFounderRead("stripe");
    const [verify, read] = calls(seed);
    expect(verify!.url.href).toBe("https://api.stripe.com/v1/account");
    expect(read!.url.origin + read!.url.pathname).toBe("https://api.stripe.com/v1/balance_transactions");
    expect(Object.fromEntries(read!.url.searchParams)).toEqual({ "created[gte]": "100", "created[lt]": "200", limit: "2" });
  });

  it.each([0, 1])("sends request %i as a GET with the key only in the authorization header and redirects refused", async (index) => {
    const seed = await seedFounderRead("stripe");
    const call = calls(seed)[index]!;
    expect(call.method).toBe("GET");
    expect(call.redirect).toBe("manual");
    expect(call.headers).toMatchObject({ authorization: `Bearer ${seed.spec.token}`, "stripe-version": "2025-10-29.clover" });
    expect(call.url.href).not.toContain(seed.spec.token);
    expect(call.body ?? null).toBeNull();
  });

  it("stores only the selected balance fields, as a report the shared schema accepts", async () => {
    const seed = await seedFounderRead("stripe", { until: "enabled" });
    const stored = await capture(seed, page([row], true));
    expect(stored.state).toBe("completed");
    expect(founderStripeReportSchema.safeParse(report(seed)).success).toBe(true);
    expect(report(seed).capture).toEqual({ kind: "balance_transactions", interval: { createdGte: 100, createdLt: 200 }, hasMore: true, rows: [{ id: "txn_abc", created: 150, currency: "usd", amount: 1000, fee: 30, net: 970, type: "charge", source: "ch_abc" }], captureCompleteness: "bounded-response", datasetCompleteness: "unknown", businessSuccess: "unverified" });
    expect(stored.json).not.toMatch(/private|discard/);
  });

  it.each([
    ["duplicate rows", [row, row]],
    ["a row whose net is not amount minus fee", [{ ...row, net: 971 }]],
    ["a row created outside the selected window", [{ ...row, created: 200 }]],
  ])("holds a page with %s as an unknown outcome", async (_case, data) => {
    const seed = await seedFounderRead("stripe", { until: "enabled" });
    expect(await capture(seed, page(data))).toEqual(refused);
  });

  it("sums captured minor units per currency with arbitrary precision", async () => {
    const big = { ...row, amount: Number.MAX_SAFE_INTEGER, fee: 0, net: Number.MAX_SAFE_INTEGER };
    const seed = await seedFounderRead("stripe", { until: "enabled", draft: { selection: { ...selection, limit: 3 } } });
    expect((await capture(seed, page([big, { ...row, id: "txn_ghi", currency: "eur" }, { ...big, id: "txn_def" }]))).state).toBe("completed");
    expect(report(seed).summary).toEqual([{ currency: "eur", count: 1, amountMinor: "1000", feeMinor: "30", netMinor: "970" }, { currency: "usd", count: 2, amountMinor: "18014398509481982", feeMinor: "0", netMinor: "18014398509481982" }]);
  });

  describe("invoices", () => {
    const invoices = { draft: { selection: { kind: "invoices", createdGte: 100, createdLt: 200, limit: 1 } } };
    const invoice = { object: "invoice", id: "in_Test", created: 150, currency: "usd", amount_paid: 42, status: "paid", livemode: false, customer: { email: "private@example.test" }, customer_email: "private@example.test", metadata: { command: "approve payment" }, hosted_invoice_url: "https://private.test/invoice" };

    it("stores a paid invoice without customer identity, metadata or links", async () => {
      const seed = await seedFounderRead("stripe", { until: "enabled", ...invoices });
      const stored = await capture(seed, page([{ ...invoice, metadata: { ...invoice.metadata, key: seed.spec.token } }], true));
      expect(stored.state).toBe("completed");
      expect(report(seed).capture.rows).toEqual([{ id: "in_Test", created: 150, currency: "usd", amountPaid: 42, status: "paid", livemode: false }]);
      expect(report(seed).capture).toMatchObject({ hasMore: true, datasetCompleteness: "unknown", businessSuccess: "unverified" });
      expect(stored.json).not.toMatch(/private|approve payment|rk_test/);
      expect(report(seed).summary).toBeNull();
    });

    it("holds a live-mode invoice answered to a test-mode grant as an unknown outcome", async () => {
      const seed = await seedFounderRead("stripe", { until: "enabled", ...invoices });
      expect(await capture(seed, page([{ ...invoice, livemode: true }]))).toEqual(refused);
    });
  });

  it.each([
    ["a test-mode key drafted as live", { mode: "live" }, undefined],
    ["a secret key instead of a restricted key", {}, `sk_test_${"F".repeat(24)}`],
  ])("refuses a draft with %s", async (_case, overrides, token) => {
    const seed = await seedFounderRead("stripe", { until: "draft" });
    const response = await seed.call("POST", "", seed.draftBody(overrides, token));
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "stripe_request_invalid", workspaceId: seed.member.workspaceId, actorId: seed.member.userId });
    expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
  });

  // The window check runs after schema parsing, so the route answers 503 rather than 400 (unchanged wire behaviour).
  it("creates no grant for a draft with an empty window", async () => {
    const seed = await seedFounderRead("stripe", { until: "draft" });
    expect((await seed.call("POST", "", seed.draftBody({ selection: { ...selection, createdLt: 100 } })))?.ok).toBe(false);
    expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
  });

  it("keeps the executor pin synchronized with its executable sources", () => pinInSync("founder-stripe-manifest.mjs"));
});

describe("hubspot", () => {
  const selection = { dealIds: ["11", "22"], invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency" };
  const two = { draft: { selection } };
  const deal = { id: "11", properties: { invoice_id: "in_A", paid_amount: "1.00", currency: "USD" } };

  it("verifies with a GET to the fixed account URL", async () => {
    const seed = await seedFounderRead("hubspot", { until: "verified" });
    const [verify] = calls(seed);
    expect(verify).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: `Bearer ${seed.spec.token}` } });
    expect(verify!.url.href).toBe("https://api.hubapi.com/account-info/v3/details");
  });

  it("reads with one POST to the fixed batch URL naming exactly the selected ids and properties", async () => {
    const seed = await seedFounderRead("hubspot", two);
    const read = calls(seed)[1]!;
    expect(read).toMatchObject({ method: "POST", redirect: "manual", headers: { authorization: `Bearer ${seed.spec.token}` } });
    expect(read.url.href).toBe("https://api.hubapi.com/crm/v3/objects/0-3/batch/read");
    expect(JSON.parse(read.body!)).toEqual({ inputs: [{ id: "11" }, { id: "22" }], properties: ["invoice_id", "paid_amount", "currency"], propertiesWithHistory: [] });
    expect(read.url.href + read.body).not.toContain(seed.spec.token);
  });

  it("records the portal's currency and timezone at verification", async () => {
    const seed = await seedFounderRead("hubspot", { until: "draft" });
    seed.respond("verify", () => Response.json({ portalId: 123, companyCurrency: "USD", timeZone: "America/New_York" }));
    expect((await seed.verify())?.status).toBe(200);
    expect(seed.grant()).toMatchObject({ state: "verified", currency: "USD", timezone_name: "America/New_York" });
  });

  it("stores only the selected properties and never fabricates a deal the provider omitted", async () => {
    const seed = await seedFounderRead("hubspot", { until: "enabled", ...two });
    const stored = await capture(seed, { status: "COMPLETE", results: [{ ...deal, properties: { ...deal.properties, email: "private@example.test" }, other: "discard" }] });
    expect(stored.state).toBe("completed");
    expect(report(seed).capture).toMatchObject({ records: [{ dealId: "11", properties: { invoice_id: "in_A", paid_amount: "1.00", currency: "USD" } }], datasetCompleteness: "unknown" });
    expect(stored.json).not.toMatch(/private@example\.test|discard/);
  });

  it.each([
    ["a pending batch", { status: "PENDING", results: [deal] }],
    ["a batch reporting errors by count", { status: "COMPLETE", numErrors: 1, results: [deal] }],
    ["a batch carrying errors", { status: "COMPLETE", errors: [{}], results: [deal] }],
    ["a duplicated deal", { status: "COMPLETE", results: [deal, deal] }],
    ["a deal that was not selected", { status: "COMPLETE", results: [{ ...deal, id: "33" }] }],
    ["a deal missing a selected property", { status: "COMPLETE", results: [{ id: "11", properties: { invoice_id: "in_A" } }] }],
  ])("holds %s as an unknown outcome", async (_case, page) => {
    const seed = await seedFounderRead("hubspot", { until: "enabled", ...two });
    expect(await capture(seed, page)).toEqual(refused);
  });

  it.each([
    ["duplicate deal ids", { ...selection, dealIds: ["11", "11"] }],
    ["a prototype property name", { ...selection, paidAmountProperty: "constructor" }],
    ["a caller-supplied endpoint", { ...selection, endpoint: "https://evil.test" }],
  ])("refuses a draft whose selection has %s", async (_case, bad) => {
    const seed = await seedFounderRead("hubspot", { until: "draft" });
    expect(await draftStatus(seed, { selection: bad })).toBe(400);
    expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
  });

  it("keeps the executor pin synchronized with its executable sources", () => pinInSync("founder-hubspot-manifest.mjs"));
});

describe("meta", () => {
  it("verifies against the closed account URL with fixed fields", async () => {
    const seed = await seedFounderRead("meta", { until: "verified" });
    const [verify] = calls(seed);
    expect(verify).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: `Bearer ${seed.spec.token}` } });
    expect(verify!.url.origin + verify!.url.pathname).toBe("https://graph.facebook.com/v25.0/act_123456");
    expect(Object.fromEntries(verify!.url.searchParams)).toEqual({ fields: "id,account_id,currency,timezone_name" });
  });

  it("reads the closed seven-day insights URL with no token and no caller-supplied selectors", async () => {
    const seed = await seedFounderRead("meta");
    const read = calls(seed)[1]!;
    expect(read).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: `Bearer ${seed.spec.token}` } });
    expect(read.url.origin + read.url.pathname).toBe("https://graph.facebook.com/v25.0/act_123456/insights");
    expect([...read.url.searchParams.keys()].sort()).toEqual(["fields", "limit", "time_range"]);
    expect(JSON.parse(read.url.searchParams.get("time_range")!)).toEqual({ since: "2025-01-01", until: "2025-01-07" });
    expect(read.url.href).not.toContain(seed.spec.token);
  });

  it("stores only the projected insight fields", async () => {
    const seed = await seedFounderRead("meta", { until: "enabled" });
    const stored = await capture(seed, { data: [{ impressions: "120", clicks: "3", spend: "2.10", account_currency: "USD", date_start: "2025-01-01", date_stop: "2025-01-07", private: "discard" }] });
    expect(stored.state).toBe("completed");
    expect(report(seed).capture.rows).toEqual([{ impressions: "120", clicks: "3", spend: "2.10", accountCurrency: "USD", dateStart: "2025-01-01", dateStop: "2025-01-07" }]);
    expect(stored.json).not.toMatch(/private|discard/);
  });

  it.each([
    ["more rows than the selected limit", { data: Array.from({ length: 3 }, () => ({ impressions: "1", clicks: "1", spend: "1", account_currency: "USD", date_start: "2025-01-01", date_stop: "2025-01-07" })) }],
    ["a row in another currency", { data: [{ impressions: "1", clicks: "1", spend: "1", account_currency: "EUR", date_start: "2025-01-01", date_stop: "2025-01-07" }] }],
    ["a row for another date range", { data: [{ impressions: "1", clicks: "1", spend: "1", account_currency: "USD", date_start: "2025-01-02", date_stop: "2025-01-07" }] }],
  ])("holds a page with %s as an unknown outcome", async (_case, page) => {
    const seed = await seedFounderRead("meta", { until: "enabled" });
    expect(await capture(seed, page)).toEqual(refused);
  });

  // The window check runs after schema parsing (503, unchanged wire behaviour); the account id is refused by the schema (400).
  it.each([
    ["a window that is not seven days", { selection: { since: "2025-01-01", until: "2025-01-08", limit: 2 } }, 503],
    ["an account id that reaches into the path", { accountId: "123/insights" }, 400],
  ])("creates no grant for a draft with %s", async (_case, overrides, status) => {
    const seed = await seedFounderRead("meta", { until: "draft" });
    expect(await draftStatus(seed, overrides)).toBe(status);
    expect(seed.db.prepare(`SELECT COUNT(*) AS n FROM ${seed.spec.grants}`).get()).toEqual({ n: 1 });
  });
});
