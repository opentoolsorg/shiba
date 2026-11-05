import { describe, expect, it } from "vitest";
import type { FounderReconciliationDraft, FounderReconciliationReport } from "@shiba/shared";
import { computeFounderReconciliation } from "../src/founder-reconciliation-compute.js";
import { founderRollingComparisonDecisionSchema, rollingFounderComparison } from "../src/founder-reconciliation-rolling.js";

const hash = "a".repeat(64), asOf = 1700000000, start = asOf - 86400;
const mapping = { invoiceIdProperty: "invoice_id", paidAmountProperty: "paid", currencyProperty: "currency", amountUnit: "major-decimal" as const, basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" as const };
const sources = {
  hubspot: { kind: "native-hubspot" as const, accountId: "123", currency: "USD", timezoneName: "UTC", grantId: "hubspot", grantVersion: 1, occurrenceId: "capture", sourceOrdinal: 0, dealIds: ["1", "2", "3", "4", "5", "6"], reportHash: hash, resultDigest: hash, connectionId: "connection", connectionVersion: 1, capturedAt: asOf * 1000, runtimeVersionId: "native-hubspot.v1", manifestDigest: hash, executorHash: hash, expiresAt: (asOf + 86400) * 1000 },
  stripe: { grantId: "stripe", receiptId: "receipt", resultDigest: hash, grantRevision: 1, accountId: "acct_fixture", mode: "test" as const, executorDigest: hash, capturedAt: asOf * 1000, createdGte: asOf - 28 * 86400, createdLt: asOf, hasMore: true, expiresAt: (asOf + 86400) * 1000 },
};
const decision = { digest: hash, reviewed: true as const, consent: "filter-captured-invoice-created-window-not-revenue-mrr-or-churn" as const, asOf, periodDays: 1 };
const deals = [
  { dealId: "1", properties: { invoice_id: "in_Start", paid: "1.20", currency: "USD" } },
  { dealId: "2", properties: { invoice_id: "in_End", paid: "100", currency: "USD" } },
  { dealId: "3", properties: { invoice_id: "in_Before", paid: "200", currency: "USD" } },
  { dealId: "4", properties: { invoice_id: "in_Euro", paid: "2.31", currency: "EUR" } },
  { dealId: "5", properties: { invoice_id: "in_Absent", paid: "500", currency: "USD" } },
];
const invoices = [
  { id: "in_Start", amountPaid: 120, currency: "usd", created: start, status: "paid", livemode: false },
  { id: "in_End", amountPaid: 10000, currency: "usd", created: asOf, status: "paid", livemode: false },
  { id: "in_Before", amountPaid: 20000, currency: "usd", created: start - 1, status: "paid", livemode: false },
  { id: "in_Euro", amountPaid: 230, currency: "eur", created: start + 1, status: "open", livemode: false },
];
function fixture() {
  const report: FounderReconciliationReport = { format: "shiba.founder-reconciliation.report.v1", id: `frc_${"a".repeat(32)}`, executorDigest: hash, sources: structuredClone(sources), mapping, ...computeFounderReconciliation(deals, invoices, mapping, sources.hubspot.dealIds), notice: "fixture", datasetCompleteness: "unknown", businessSuccess: "unverified" };
  const draft: FounderReconciliationDraft = { id: report.id, digest: hash, executorDigest: hash, state: "completed", expiresAt: (asOf + 86400) * 1000, mapping, sources: report.sources, reportHash: hash };
  return { report, draft };
}

describe("explicit bounded rolling captured comparison", () => {
  it("uses UTC seconds and half-open invoice-created boundaries, not payment dates", () => {
    const { draft, report } = fixture();
    const result = rollingFounderComparison(draft, report, decision);
    expect(result.rows.map(row => row.invoiceId)).toEqual(["in_Start", "in_Euro"]);
    expect(result.perCurrency).toEqual([
      { currency: "EUR", matchedCount: 1, crmMinor: "231", stripeMinor: "230", differenceMinor: "1" },
      { currency: "USD", matchedCount: 1, crmMinor: "120", stripeMinor: "120", differenceMinor: "0" },
    ]);
    expect(result.outsidePeriodRowCount).toBe(2);
    expect(result.unassignedRows.map(row => row.status)).toEqual(["unmatched_in_capture", "uncaptured_deal"]);
    expect(result).toMatchObject({ sourceReportHash: hash, datasetCompleteness: "unknown", businessSuccess: "unverified", sources: { stripe: { hasMore: true } } });
    expect(result.metricDefinition).toContain("not payments received during the window");
  });
  it("is deterministic on retries and never mutates or widens captured evidence", () => {
    const { draft, report } = fixture(), original = structuredClone(report);
    expect(rollingFounderComparison(draft, report, decision, asOf * 1000)).toEqual(rollingFounderComparison(draft, report, decision, asOf * 1000));
    expect(report).toEqual(original);
    expect(rollingFounderComparison(draft, report, { ...decision, periodDays: 28 }).period.createdGte).toBe(sources.stripe.createdGte);
  });
  it("retains ambiguous rows without attributing them to a period or summing them", () => {
    const { draft, report } = fixture();
    Object.assign(report, computeFounderReconciliation([...deals, { ...deals[0]!, dealId: "7" }], invoices, mapping, []));
    const result = rollingFounderComparison(draft, report, decision);
    expect(result.unassignedRows.filter(row => row.status === "duplicate_key")).toHaveLength(2);
    expect(result.perCurrency.some(total => total.currency === "USD")).toBe(false);
  });
  it("keeps dated duplicate invoices without CRM matches unassigned too", () => {
    const { draft, report } = fixture();
    Object.assign(report, computeFounderReconciliation([], [invoices[0]!, invoices[0]!], mapping, []));
    const result = rollingFounderComparison(draft, report, decision);
    expect(result.rows).toEqual([]);
    expect(result.unassignedRows).toHaveLength(2);
    expect(result.unassignedRows.every(row => row.status === "duplicate_key")).toBe(true);
    expect(result.perCurrency).toEqual([]);
    expect(result.outsidePeriodRowCount).toBe(0);
  });
  it("does not turn invalid money or unsupported currencies into totals", () => {
    const { draft, report } = fixture();
    Object.assign(report, computeFounderReconciliation([{ ...deals[0]!, properties: { invoice_id: "in_Start", paid: "1e2", currency: "USD" } }], invoices, mapping, []));
    const result = rollingFounderComparison(draft, report, decision);
    expect(result.rows[0]?.status).toBe("non_comparable");
    expect(result.perCurrency).toEqual([]);
  });
  it.each([{ periodDays: 0 }, { periodDays: 29 }, { periodDays: 1.5 }, { asOf: 1.5 }, { asOf: -1 }, { reviewed: false }, { consent: "compare-exact-captured-receipts" }, { metric: "revenue" }])("rejects invalid or implicit consent %j", changes => {
    expect(founderRollingComparisonDecisionSchema.safeParse({ ...decision, ...changes }).success).toBe(false);
  });
  it("rejects windows beyond the captured interval and future endpoints", () => {
    const { draft, report } = fixture();
    expect(() => rollingFounderComparison(draft, report, { ...decision, asOf: asOf + 1 })).toThrow("reconciliation_rolling_outside_capture");
    expect(() => rollingFounderComparison(draft, report, { ...decision, periodDays: 28, asOf: asOf - 1 })).toThrow("reconciliation_rolling_outside_capture");
    expect(() => rollingFounderComparison(draft, report, decision, asOf * 1000 - 1)).toThrow("reconciliation_rolling_future_capture");
  });
  it.each(["draft", "revoked"] as const)("rejects %s source comparisons", state => {
    const { draft, report } = fixture();
    expect(() => rollingFounderComparison({ ...draft, state }, report, decision)).toThrow("reconciliation_rolling_review_required");
  });
  it("rejects a stale review digest, unavailable report hash and malformed captured output", () => {
    const { draft, report } = fixture();
    expect(() => rollingFounderComparison(draft, report, { ...decision, digest: "b".repeat(64) })).toThrow("reconciliation_rolling_review_required");
    expect(() => rollingFounderComparison({ ...draft, reportHash: null }, report, decision)).toThrow("reconciliation_rolling_review_required");
    expect(() => rollingFounderComparison(draft, {}, decision)).toThrow();
  });
});


describe("rolling metric contracts and provenance", () => {
  it.each(["mrr", "churn"] as const)("never relabels invoice totals as %s", metric => {
    const { draft, report } = fixture();
    const result = rollingFounderComparison(draft, report, { ...decision, metric });
    expect(result.selectedMetric).toBe(metric);
    expect(result.metricAvailability.status).toBe("unavailable");
    expect(result.metricAvailability.missingDataReasons).toHaveLength(3);
    expect(result.metricAvailability.missingDataReasons.join(" ")).toContain("definition_contract_missing");
    expect(result.perCurrency).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });
  it("reports partial, stale, missing and independently timed evidence without a completeness claim", () => {
    const { draft, report } = fixture();
    report.sources.hubspot.capturedAt -= 3600000;
    const result = rollingFounderComparison(draft, report, decision, (asOf + 86400) * 1000);
    expect(result.completeness).toMatchObject({
      captureSkewMs: 3600000,
      sourceAgesMs: { hubspot: 90000000, stripe: 86400000 },
      statusCounts: { matched_equal: 1, matched_difference: 1, unmatched_in_capture: 1, uncaptured_deal: 1 },
    });
    expect(result.completeness.reasons).toEqual(expect.arrayContaining(["stripe_capture_has_more_pages", "uncaptured_deal", "source_capture_expired", "source_capture_times_differ"]));
    expect(result.provenance).toEqual({ reviewDigest: hash, reportId: report.id, reportHash: hash, executorDigest: hash });
    expect(result.datasetCompleteness).toBe("unknown");
  });
  it("does not interpret a CRM timezone or daylight saving transition as a variable-length rolling day", () => {
    const { draft, report } = fixture();
    report.sources.hubspot.timezoneName = "America/New_York";
    const result = rollingFounderComparison(draft, report, decision);
    expect(result.period).toMatchObject({ timezone: "UTC", durationSeconds: 86400, createdGte: start, createdLt: asOf });
  });
  it("sums minor units beyond JS safe integer range without currency conversion", () => {
    const { draft, report } = fixture();
    Object.assign(report, computeFounderReconciliation([
      { dealId: "1", properties: { invoice_id: "in_Start", paid: "900719925474099312345.67", currency: "USD" } },
      { dealId: "2", properties: { invoice_id: "in_Euro", paid: "123", currency: "JPY" } },
    ], [invoices[0]!, { ...invoices[3]!, currency: "jpy", amountPaid: 123 }], mapping, []));
    expect(rollingFounderComparison(draft, report, decision).perCurrency).toEqual([
      { currency: "JPY", matchedCount: 1, crmMinor: "123", stripeMinor: "123", differenceMinor: "0" },
      { currency: "USD", matchedCount: 1, crmMinor: "90071992547409931234567", stripeMinor: "120", differenceMinor: "90071992547409931234447" },
    ]);
  });
  it("rejects future source captures even for a historical period", () => {
    const { draft, report } = fixture();
    report.sources.stripe.capturedAt = asOf * 1000 + 1;
    expect(() => rollingFounderComparison(draft, report, decision, asOf * 1000)).toThrow("reconciliation_rolling_future_capture");
  });
  it.each(["id", "executorDigest", "mapping", "sources"] as const)("rejects report %s not bound to the reviewed draft", field => {
    const { draft, report } = fixture();
    const modified = structuredClone(report);
    if (field === "id") modified.id = "another-report";
    if (field === "executorDigest") modified.executorDigest = "b".repeat(64);
    if (field === "mapping") modified.mapping.paidAmountProperty = "other_amount";
    if (field === "sources") modified.sources.stripe.receiptId = "another-receipt";
    expect(() => rollingFounderComparison(draft, modified, decision)).toThrow("reconciliation_rolling_source_invalid");
  });
  it("fails closed on malformed matched integer amounts instead of truncating or coercing", () => {
    const { draft, report } = fixture();
    report.rows[0]!.crmMinor = "1e20";
    expect(() => rollingFounderComparison(draft, report, decision)).toThrow("reconciliation_rolling_source_invalid");
  });
});
