import { loadEvidence } from "./reads/index.js";
import { WorkspaceIntegrationError } from "../workspace-integrations-store.js";
import type { WorkspaceNativeMember } from "../workspace-native-authority.js";
import type { FounderReconciliationInput } from "@shiba/shared";
import type { CapturedDeal, CapturedInvoice } from "./founder-reconciliation-compute.js";
import type { FounderReadsEnv } from "./reads/index.js";

const fail = (): never => { throw new WorkspaceIntegrationError("reconciliation_sources_changed", 409); };
export interface ReconciliationSourceProof {
  sources: {
    hubspot: { kind: "native-hubspot"; accountId: string; currency: string; timezoneName: string; grantId: string; grantVersion: number; occurrenceId: string; sourceOrdinal: number; dealIds: string[]; reportHash: string; resultDigest: string; connectionId: string; connectionVersion: number; capturedAt: number; runtimeVersionId: string; manifestDigest: string; executorHash: string; expiresAt: number };
    stripe: { grantId: string; receiptId: string; resultDigest: string; grantRevision: number; accountId: string; mode: "live" | "test"; executorDigest: string; capturedAt: number; createdGte: number; createdLt: number; hasMore: boolean; expiresAt: number };
  };
  deals: CapturedDeal[];
  invoices: CapturedInvoice[];
  sql: string;
  values: unknown[];
  expiresAt: number;
}

/** Loads current authorized read evidence; caller input supplies references, never report bytes or money. */
export async function loadReconciliationSources(env: FounderReadsEnv, member: WorkspaceNativeMember, input: FounderReconciliationInput): Promise<ReconciliationSourceProof> {
  if (input.hubspot.sourceOrdinal !== 0) return fail();
  const [hubEvidence, stripeEvidence] = await Promise.all([
    loadEvidence(env, member, { provider: "hubspot", grantId: input.hubspot.grantId, receiptId: input.hubspot.occurrenceId, grantRevision: input.hubspot.grantVersion }),
    loadEvidence(env, member, { provider: "stripe", grantId: input.stripe.grantId, receiptId: input.stripe.receiptId }),
  ]);
  if (!hubEvidence || !stripeEvidence) return fail();
  // Evidence arrives parsed by each provider's strict report schema and bound to its pin; only the reconciliation's own rules are checked here.
  const hubPin = hubEvidence.pin, hubReport = hubEvidence.report, hubSelection = hubEvidence.selection;
  const mapping = input.mapping;
  const mapped = [mapping.invoiceIdProperty, mapping.paidAmountProperty, mapping.currencyProperty].sort().join(",");
  if (!hubPin.facts.currency || !hubPin.facts.timezoneName || hubSelection.invoiceIdProperty !== mapping.invoiceIdProperty || hubSelection.paidAmountProperty !== mapping.paidAmountProperty || hubSelection.currencyProperty !== mapping.currencyProperty || hubReport.capture.records.length > hubSelection.dealIds.length) return fail();
  const deals: CapturedDeal[] = hubReport.capture.records;
  if (deals.some((deal) => Object.keys(deal.properties).sort().join(",") !== mapped || !hubSelection.dealIds.includes(deal.dealId)) || new Set(deals.map((deal) => deal.dealId)).size !== deals.length) return fail();

  const stripePin = stripeEvidence.pin, stripeReport = stripeEvidence.report, stripeCapture = stripeReport.capture, selection = stripeEvidence.selection;
  if (stripeCapture.kind !== "invoices" || selection.kind !== "invoices" || stripeCapture.rows.length > selection.limit) return fail();
  const invoices: CapturedInvoice[] = stripeCapture.rows.map((row) => {
    if (!("amountPaid" in row) || !/^in_[A-Za-z0-9]{1,200}$/.test(row.id) || row.livemode !== (stripePin.facts.mode === "live")) return fail();
    return { id: row.id, currency: row.currency, amountPaid: row.amountPaid, created: row.created, livemode: row.livemode, status: row.status };
  });
  const interval = stripeCapture.interval;
  if (interval.createdGte !== selection.createdGte || interval.createdLt !== selection.createdLt) return fail();

  const expiresAt = Math.min(hubEvidence.expiresAt, stripeEvidence.expiresAt);
  if (expiresAt <= Date.now()) return fail();
  const hubReceipt = hubEvidence.receipt; const stripeReceipt = stripeEvidence.receipt;
  const sources = {
    hubspot: { kind: "native-hubspot" as const, accountId: hubPin.accountId, currency: hubPin.facts.currency, timezoneName: hubPin.facts.timezoneName, ...input.hubspot, dealIds: hubSelection.dealIds, reportHash: hubReceipt.resultDigest, resultDigest: hubReceipt.resultDigest, connectionId: hubPin.grantId, connectionVersion: hubPin.revision, capturedAt: hubReport.capturedAt, runtimeVersionId: "native-hubspot.v1", manifestDigest: hubPin.executorDigest, executorHash: hubPin.executorDigest, expiresAt: hubEvidence.expiresAt },
    stripe: { ...input.stripe, resultDigest: stripeReceipt.resultDigest, grantRevision: stripePin.revision, accountId: stripePin.accountId, mode: stripePin.facts.mode, executorDigest: stripePin.executorDigest, capturedAt: stripeReport.capturedAt, createdGte: interval.createdGte, createdLt: interval.createdLt, hasMore: stripeCapture.hasMore, expiresAt: stripeEvidence.expiresAt },
  };
  // Each evidence fence re-proves owner membership, the exact grant row and the exact completed, unexpired receipt bytes.
  const hubFence = hubEvidence.fence;
  const stripeFence = stripeEvidence.fence;
  return { sources, deals, invoices, sql: `(${hubFence.sql}) AND (${stripeFence.sql})`, values: [...hubFence.values, ...stripeFence.values], expiresAt };
}
