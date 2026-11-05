import type { FounderReconciliationSchedule } from "@shiba/shared";
import { reconciliationDraft } from "./founder-reconciliation-fixtures";
export { RECON_ACTOR as SCHEDULE_ACTOR, RECON_WORKSPACE as SCHEDULE_WORKSPACE, reconScope as scheduleScope } from "./founder-reconciliation-fixtures";
export function standingComparison(): FounderReconciliationSchedule {
  const sample = reconciliationDraft(), now = Date.now();
  sample.sources.hubspot.capturedAt = now - 60000; sample.sources.stripe.capturedAt = now - 60000;
  return { id: `frs_${"a".repeat(32)}`, digest: "b".repeat(64), state: "draft", expiresAt: now + 21600000, maxComparisons: 3, maxSkewMinutes: 60, usedComparisons: 0, cutoffAt: null, nextDueAt: null, sampleId: sample.id, sampleHash: "c".repeat(64), executorDigest: "d".repeat(64), reconciliationExecutorDigest: "9".repeat(64), hubspotContractDigest: "e".repeat(64), stripeContractDigest: "f".repeat(64), hubspotGrantExpiresAt: now + 86400000, stripeGrantExpiresAt: now + 86400000, mapping: sample.mapping, sampleSources: sample.sources, reviewExpiresAt: now + 60000,
    sourceGrants: { hubspot: { id: sample.sources.hubspot.grantId, revision: sample.sources.hubspot.grantVersion, digest: "e".repeat(64), executorDigest: sample.sources.hubspot.executorHash, expiresAt: now + 86400000 }, stripe: { id: sample.sources.stripe.grantId, revision: sample.sources.stripe.grantRevision, digest: "f".repeat(64), executorDigest: sample.sources.stripe.executorDigest, expiresAt: now + 86400000 } } };
}
/** Complete wire fixture for the private-result-to-sharing handoff. */
export async function scheduledCapture() {
  const schedule = { ...standingComparison(), state: "enabled" as const, cutoffAt: Date.now() - 30000, usedComparisons: 2 };
  const resultId = `frr_${"1".repeat(32)}`, expiresAt = Date.now() + 60000;
  const sources = structuredClone(schedule.sampleSources);
  sources.hubspot.occurrenceId = `fhr_${"2".repeat(32)}`; sources.stripe.receiptId = `fsr_${"4".repeat(32)}`;
  sources.hubspot.capturedAt = Date.now() - 2000; sources.stripe.capturedAt = Date.now() - 1000;
  const report = { format: "shiba.founder-reconciliation.scheduled-report.v1", id: resultId, scheduleId: schedule.id, scheduleDigest: schedule.digest, sourceGrants: schedule.sourceGrants, principal: { kind: "schedule", id: `schedule:${schedule.id}` }, authorization: "standing-future-comparison-consent", mapping: schedule.mapping, sources, rows: [], perCurrency: [], notice: "Bounded captures only.", datasetCompleteness: "unknown", businessSuccess: "unverified" };
  const data = JSON.stringify([report.format, resultId, expiresAt, JSON.stringify(report)]);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))), (n) => n.toString(16).padStart(2, "0")).join("");
  return { schedule, report, digest, receipt: { id: resultId, scheduleId: schedule.id, state: "completed" as const, createdAt: Date.now(), expiresAt, reportHash: digest } };
}
