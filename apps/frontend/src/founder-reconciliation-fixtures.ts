import type { FounderReconciliationDraft } from "@shiba/shared";
export const RECON_WORKSPACE = `ws_${"a".repeat(24)}`, RECON_ACTOR = "founder@example.test", reconScope = { workspaceId: RECON_WORKSPACE, actorId: RECON_ACTOR };
export function reconciliationDraft(): FounderReconciliationDraft { const expiresAt = Date.now() + 300000; return { id: `frc_${"1".repeat(32)}`, digest: "a".repeat(64), executorDigest: "9".repeat(64), state: "draft", expiresAt, reportHash: null,
  mapping: { invoiceIdProperty: "invoice_id", paidAmountProperty: "paid_amount", currencyProperty: "currency", amountUnit: "major-decimal", basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" },
  sources: { hubspot: { kind: "native-hubspot", accountId: "123456789", currency: "USD", timezoneName: "UTC", grantId: `fhc_${"b".repeat(32)}`, grantVersion: 1, occurrenceId: `fhr_${"4".repeat(32)}`, sourceOrdinal: 0, dealIds: ["1"], reportHash: "b".repeat(64), resultDigest: "c".repeat(64), connectionId: "conn", connectionVersion: 1, capturedAt: Date.now(), runtimeVersionId: "native-hubspot.v1", manifestDigest: "d".repeat(64), executorHash: "e".repeat(64), expiresAt: expiresAt + 100000 }, stripe: { grantId: `fsc_${"2".repeat(32)}`, receiptId: `fsr_${"3".repeat(32)}`, resultDigest: "f".repeat(64), grantRevision: 1, accountId: "acct_fixture", mode: "test", executorDigest: "1".repeat(64), capturedAt: Date.now(), createdGte: 1, createdLt: 2, hasMore: true, expiresAt: expiresAt + 100000 } } }; }

export async function completedReconciliationCapture() {
  const draft = reconciliationDraft(), asOf = Math.floor(Date.now() / 1000) - 60;
  draft.state = "completed";
  draft.sources.hubspot.capturedAt = (asOf - 30) * 1000;
  draft.sources.stripe.capturedAt = asOf * 1000;
  draft.sources.stripe.createdGte = asOf - 28 * 86400;
  draft.sources.stripe.createdLt = asOf;
  const report = {
    format: "shiba.founder-reconciliation.report.v1" as const, id: draft.id, executorDigest: draft.executorDigest,
    sources: draft.sources, mapping: draft.mapping,
    rows: [{ status: "matched_equal" as const, dealId: "1", invoiceId: "in_fixture", stripeStatus: "paid", invoiceCreated: asOf - 86400, currency: "USD", crmMinor: "90071992547409930001", stripeMinor: "90071992547409930001", differenceMinor: "0", reason: null }],
    perCurrency: [{ currency: "USD", matchedCount: 1, crmMinor: "90071992547409930001", stripeMinor: "90071992547409930001", differenceMinor: "0" }],
    notice: "Fixture captured subsets only", datasetCompleteness: "unknown" as const, businessSuccess: "unverified" as const,
  };
  const data = JSON.stringify([report.format, draft.id, draft.expiresAt, JSON.stringify(report)]);
  draft.reportHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))), (n) => n.toString(16).padStart(2, "0")).join("");
  return { draft, report, asOf };
}

export function rollingReconciliationFixture(capture: Awaited<ReturnType<typeof completedReconciliationCapture>>, selection = { asOf: capture.asOf, periodDays: 7, metric: "invoice-paid-snapshot" as "invoice-paid-snapshot" | "mrr" | "churn" }) {
  const { draft, report } = capture;
  return {
    format: "shiba.founder-reconciliation.rolling-view.v1" as const,
    sourceReportId: draft.id, sourceReportHash: draft.reportHash!, sourceExecutorDigest: draft.executorDigest,
    sources: draft.sources, mapping: draft.mapping,
    provenance: { reviewDigest: draft.digest, reportId: draft.id, reportHash: draft.reportHash!, executorDigest: draft.executorDigest },
    selectedMetric: selection.metric,
    metricAvailability: { status: selection.metric === "invoice-paid-snapshot" ? "qualified" as const : "unavailable" as const, missingDataReasons: selection.metric === "invoice-paid-snapshot" ? [] : selection.metric === "mrr" ? ["subscription_lifecycle_snapshots_not_captured", "recurring_price_quantity_interval_and_effective_dates_not_captured", "reviewed_mrr_definition_contract_missing"] : ["subscription_lifecycle_events_and_period_start_cohort_not_captured", "cancellations_reactivations_and_effective_dates_not_captured", "reviewed_churn_denominator_and_definition_contract_missing"] },
    completeness: { reasons: ["stripe_capture_has_more_pages", "source_capture_times_differ"], statusCounts: { matched_equal: 1 }, captureSkewMs: 30000, sourceAgesMs: { hubspot: 90000, stripe: 60000 } },
    period: { timezone: "UTC" as const, durationSeconds: selection.periodDays * 86400, basis: "stripe-invoice-created-unix-seconds" as const, createdGte: selection.asOf - selection.periodDays * 86400, createdLt: selection.asOf, periodDays: selection.periodDays, boundary: "inclusive-start-exclusive-end" as const },
    metricDefinition: selection.metric === "invoice-paid-snapshot" ? "Sum matched snapshot amount_paid, not revenue or period payments." : "Subscription metric unavailable: lifecycle data and reviewed definition missing.",
    rows: report.rows, unassignedRows: [], outsidePeriodRowCount: 0,
    perCurrency: selection.metric === "invoice-paid-snapshot" ? report.perCurrency : [],
    notice: "Bounded fixture view, not a complete ledger or refreshed report.", datasetCompleteness: "unknown" as const, businessSuccess: "unverified" as const,
  };
}
