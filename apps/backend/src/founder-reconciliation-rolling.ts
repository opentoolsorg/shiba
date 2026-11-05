import { z } from "zod";
import { founderReconciliationReportSchema, type FounderReconciliationDraft } from "@shiba/shared";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";

export const founderRollingComparisonDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
  consent: z.literal("filter-captured-invoice-created-window-not-revenue-mrr-or-churn"),
  asOf: z.number().int().nonnegative().max(253402300799),
  periodDays: z.number().int().min(1).max(28),
  metric: z.enum(["invoice-paid-snapshot", "mrr", "churn"]).optional(),
});

/** A pure view of one approved capture, not permission to refresh its sources. */
export function rollingFounderComparison(
  draft: FounderReconciliationDraft,
  capturedReport: unknown,
  decision: z.infer<typeof founderRollingComparisonDecisionSchema>,
  now = Date.now(),
) {
  const input = founderRollingComparisonDecisionSchema.parse(decision);
  if (draft.state !== "completed" || !draft.reportHash || draft.digest !== input.digest) {
    throw new WorkspaceIntegrationError("reconciliation_rolling_review_required", 409);
  }
  const report = founderReconciliationReportSchema.parse(capturedReport);
  if (report.id !== draft.id || report.executorDigest !== draft.executorDigest ||
      JSON.stringify(report.sources) !== JSON.stringify(draft.sources) ||
      JSON.stringify(report.mapping) !== JSON.stringify(draft.mapping)) {
    throw new WorkspaceIntegrationError("reconciliation_rolling_source_invalid", 409);
  }
  if (report.sources.hubspot.capturedAt > now || report.sources.stripe.capturedAt > now) {
    throw new WorkspaceIntegrationError("reconciliation_rolling_future_capture", 409);
  }
  const selectedMetric = input.metric ?? "invoice-paid-snapshot";
  const missingDataReasons = selectedMetric === "invoice-paid-snapshot" ? [] : selectedMetric === "mrr" ? [
    "subscription_lifecycle_snapshots_not_captured",
    "recurring_price_quantity_interval_and_effective_dates_not_captured",
    "reviewed_mrr_definition_contract_missing",
  ] : [
    "subscription_lifecycle_events_and_period_start_cohort_not_captured",
    "cancellations_reactivations_and_effective_dates_not_captured",
    "reviewed_churn_denominator_and_definition_contract_missing",
  ];
  const createdLt = input.asOf, createdGte = createdLt - input.periodDays * 86400;
  if (createdLt > Math.floor(now / 1000) || createdGte < report.sources.stripe.createdGte || createdLt > report.sources.stripe.createdLt) {
    throw new WorkspaceIntegrationError("reconciliation_rolling_outside_capture", 400);
  }
  const rows = report.rows.filter(row => row.status !== "duplicate_key" && row.invoiceCreated !== null && row.invoiceCreated >= createdGte && row.invoiceCreated < createdLt);
  const unassignedRows = report.rows.filter(row => row.invoiceCreated === null || row.status === "duplicate_key");
  const totals = new Map<string, { count: number; crm: bigint; stripe: bigint }>();
  for (const row of rows) {
    if (row.status !== "matched_equal" && row.status !== "matched_difference") continue;
    if (!row.currency || !/^[A-Z]{3}$/.test(row.currency) || row.crmMinor === null || row.stripeMinor === null ||
        !/^-?(0|[1-9][0-9]{0,51})$/.test(row.crmMinor) || !/^-?(0|[1-9][0-9]{0,51})$/.test(row.stripeMinor)) {
      throw new WorkspaceIntegrationError("reconciliation_rolling_source_invalid", 409);
    }
    const total = totals.get(row.currency) ?? { count: 0, crm: 0n, stripe: 0n };
    total.count++;
    total.crm += BigInt(row.crmMinor);
    total.stripe += BigInt(row.stripeMinor);
    totals.set(row.currency, total);
  }
  const statusCounts: Record<string, number> = {};
  for (const row of [...rows, ...unassignedRows]) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  const reasons = ["selected_crm_deals_not_complete_ledger", "independently_timed_snapshot_amounts_not_period_payment_events"];
  if (report.sources.stripe.hasMore) reasons.push("stripe_capture_has_more_pages");
  if (unassignedRows.length) reasons.push("undated_or_ambiguous_rows_not_assigned_to_period");
  for (const status of ["duplicate_key", "missing_key", "invalid_key", "unmatched_in_capture", "uncaptured_deal", "non_comparable"] as const) {
    if (statusCounts[status]) reasons.push(status);
  }
  if (report.sources.hubspot.capturedAt !== report.sources.stripe.capturedAt) reasons.push("source_capture_times_differ");
  if (now >= report.sources.hubspot.expiresAt || now >= report.sources.stripe.expiresAt) reasons.push("source_capture_expired");
  return {
    format: "shiba.founder-reconciliation.rolling-view.v1" as const,
    sourceReportId: report.id,
    sourceReportHash: draft.reportHash,
    sourceExecutorDigest: report.executorDigest,
    sources: report.sources,
    mapping: report.mapping,
    provenance: { reviewDigest: input.digest, reportId: report.id, reportHash: draft.reportHash, executorDigest: report.executorDigest },
    selectedMetric,
    metricAvailability: { status: selectedMetric === "invoice-paid-snapshot" ? "qualified" as const : "unavailable" as const, missingDataReasons },
    completeness: { reasons, statusCounts, captureSkewMs: Math.abs(report.sources.hubspot.capturedAt - report.sources.stripe.capturedAt), sourceAgesMs: { hubspot: now - report.sources.hubspot.capturedAt, stripe: now - report.sources.stripe.capturedAt } },
    period: { timezone: "UTC" as const, durationSeconds: input.periodDays * 86400, basis: "stripe-invoice-created-unix-seconds" as const, createdGte, createdLt, periodDays: input.periodDays, boundary: "inclusive-start-exclusive-end" as const },
    metricDefinition: selectedMetric === "mrr" ? "MRR unavailable: invoice amount_paid is not a recurring subscription run rate; lifecycle inputs and a reviewed normalization contract are required." : selectedMetric === "churn" ? "Churn unavailable: invoice matches do not establish a period-start subscription cohort or cancellation events; a reviewed denominator and event contract are required." : "Sum snapshot amount_paid and attested CRM paid amounts only for unique, comparable matched invoices created in the selected window; currencies are separate; amounts are as captured, not payments received during the window.",
    rows,
    unassignedRows,
    outsidePeriodRowCount: report.rows.length - rows.length - unassignedRows.length,
    perCurrency: selectedMetric !== "invoice-paid-snapshot" ? [] : [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, matchedCount: total.count, crmMinor: total.crm.toString(), stripeMinor: total.stripe.toString(), differenceMinor: (total.crm - total.stripe).toString() })),
    notice: "A bounded view of independently timed captured subsets, not a refreshed report or historical ledger. Undated and ambiguous rows remain unassigned, never treated as outside the window. No revenue, MRR, churn, payment-date or complete reconciliation claim. Repeating this request does not refresh data or grant future consent.",
    datasetCompleteness: "unknown" as const,
    businessSuccess: "unverified" as const,
  };
}
