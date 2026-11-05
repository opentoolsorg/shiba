import { z } from "zod";
import { founderReconciliationReportSchema, type FounderReconciliationDraft } from "@shiba/shared";
import { WorkspaceIntegrationError } from "./workspace-integrations-store.js";

export const founderRollingComparisonDecisionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
  consent: z.literal("filter-captured-invoice-created-window-not-revenue-mrr-or-churn"),
  asOf: z.number().int().nonnegative().max(253402300799),
  periodDays: z.number().int().min(1).max(28),
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
  const createdLt = input.asOf, createdGte = createdLt - input.periodDays * 86400;
  if (createdLt > Math.floor(now / 1000) || createdGte < report.sources.stripe.createdGte || createdLt > report.sources.stripe.createdLt) {
    throw new WorkspaceIntegrationError("reconciliation_rolling_outside_capture", 400);
  }
  const rows = report.rows.filter(row => row.status !== "duplicate_key" && row.invoiceCreated !== null && row.invoiceCreated >= createdGte && row.invoiceCreated < createdLt);
  const unassignedRows = report.rows.filter(row => row.invoiceCreated === null || row.status === "duplicate_key");
  const totals = new Map<string, { count: number; crm: bigint; stripe: bigint }>();
  for (const row of rows) {
    if (row.status !== "matched_equal" && row.status !== "matched_difference") continue;
    if (!row.currency || row.crmMinor === null || row.stripeMinor === null) {
      throw new WorkspaceIntegrationError("reconciliation_rolling_source_invalid", 409);
    }
    const total = totals.get(row.currency) ?? { count: 0, crm: 0n, stripe: 0n };
    total.count++;
    total.crm += BigInt(row.crmMinor);
    total.stripe += BigInt(row.stripeMinor);
    totals.set(row.currency, total);
  }
  return {
    format: "shiba.founder-reconciliation.rolling-view.v1" as const,
    sourceReportId: report.id,
    sourceReportHash: draft.reportHash,
    sourceExecutorDigest: report.executorDigest,
    sources: report.sources,
    mapping: report.mapping,
    period: { basis: "stripe-invoice-created-unix-seconds" as const, createdGte, createdLt, periodDays: input.periodDays, boundary: "inclusive-start-exclusive-end" as const },
    metricDefinition: "Sum snapshot amount_paid and attested CRM paid amounts only for unique, comparable matched invoices created in the selected window; currencies are separate; amounts are as captured, not payments received during the window.",
    rows,
    unassignedRows,
    outsidePeriodRowCount: report.rows.length - rows.length - unassignedRows.length,
    perCurrency: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, matchedCount: total.count, crmMinor: total.crm.toString(), stripeMinor: total.stripe.toString(), differenceMinor: (total.crm - total.stripe).toString() })),
    notice: "A bounded view of independently timed captured subsets, not a refreshed report or historical ledger. Undated and ambiguous rows remain unassigned, never treated as outside the window. No revenue, MRR, churn, payment-date or complete reconciliation claim. Repeating this request does not refresh data or grant future consent.",
    datasetCompleteness: "unknown" as const,
    businessSuccess: "unverified" as const,
  };
}
