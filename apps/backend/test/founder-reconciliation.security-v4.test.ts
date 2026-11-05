import { describe, expect, it } from "vitest";
import { computeFounderReconciliation, type CapturedDeal, type CapturedInvoice } from "../src/founder-reconciliation-compute.js";

const mapping = { invoiceIdProperty: "invoice", paidAmountProperty: "paid", currencyProperty: "currency", amountUnit: "major-decimal" as const, basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" as const };
const deal = (id = "1", invoice = "in_One", paid = "1.20", currency = "USD"): CapturedDeal => ({ dealId: id, properties: { invoice, paid, currency } });
const invoice = (id = "in_One", amountPaid = 120, currency = "usd"): CapturedInvoice => ({ id, amountPaid, currency, status: "paid", created: 100, livemode: false });

describe("independent v4 captured financial arithmetic", () => {
  it("excludes all ambiguous invoice IDs from matched totals", () => {
    for (const [deals, invoices] of [ [[deal(), deal("2")], [invoice()]], [[deal()], [invoice(), invoice()]] ] as [CapturedDeal[], CapturedInvoice[]][]) {
      const report = computeFounderReconciliation(deals, invoices, mapping, []);
      expect(report.rows.every(row => row.status === "duplicate_key")).toBe(true);
      expect(report.perCurrency).toEqual([]);
    }
    expect(() => computeFounderReconciliation([deal(), deal()], [invoice()], mapping, [])).toThrow();
  });
  it("keeps currencies separate and uses exact decimal arithmetic", () => {
    const report = computeFounderReconciliation([deal(), deal("2", "in_Two", "2.31", "EUR")], [invoice(), invoice("in_Two", 230, "eur")], mapping, []);
    expect(report.perCurrency).toEqual([{ currency: "EUR", matchedCount: 1, crmMinor: "231", stripeMinor: "230", differenceMinor: "1" }, { currency: "USD", matchedCount: 1, crmMinor: "120", stripeMinor: "120", differenceMinor: "0" }]);
  });
  it("does not coerce unsupported units, floating values, exponent syntax or absent money", () => {
    for (const row of [deal("1", "in_One", "1e2"), deal("1", "in_One", "1.201"), deal("1", "in_One", ""), deal("1", "in_One", "1", "KWD")]) {
      expect(computeFounderReconciliation([row], [invoice()], mapping, []).rows[0]?.status).toBe("non_comparable");
    }
    expect(computeFounderReconciliation([deal()], [invoice("in_One", 1.2)], mapping, []).perCurrency).toEqual([]);
    expect(computeFounderReconciliation([deal()], [invoice()], { ...mapping, amountUnit: "minor-integer" }, []).perCurrency).toEqual([]);
  });
  it("reports absence only within the captured input and excludes absent keys from totals", () => {
    const report = computeFounderReconciliation([deal("1", "in_Missing"), deal("2", ""), deal("3", "https://evil.test")], [invoice()], mapping, []);
    expect(report.rows.map(row => row.status)).toEqual(["unmatched_in_capture", "missing_key", "invalid_key", "unmatched_in_capture"]);
    expect(report.perCurrency).toEqual([]);
  });
  it("marks a selected but unreturned deal as uncaptured without assigning an invoice or money", () => {
    const report = computeFounderReconciliation([deal()], [invoice()], mapping, ["1", "2"]);
    expect(report.rows.find(row => row.dealId === "2")).toMatchObject({ status: "uncaptured_deal", invoiceId: null, crmMinor: null, stripeMinor: null, differenceMinor: null });
    expect(report.perCurrency).toEqual([{ currency: "USD", matchedCount: 1, crmMinor: "120", stripeMinor: "120", differenceMinor: "0" }]);
  });
});
