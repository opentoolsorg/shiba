import type { FounderReconciliationSchedule } from "@shiba/shared";
import { reconciliationDraft } from "./founder-reconciliation-fixtures";
export { RECON_ACTOR as SCHEDULE_ACTOR, RECON_WORKSPACE as SCHEDULE_WORKSPACE, reconScope as scheduleScope } from "./founder-reconciliation-fixtures";
export function standingComparison(): FounderReconciliationSchedule {
  const sample = reconciliationDraft(), now = Date.now();
  sample.sources.hubspot.capturedAt = now - 60000; sample.sources.stripe.capturedAt = now - 60000;
  return { id: `frs_${"a".repeat(32)}`, digest: "b".repeat(64), state: "draft", expiresAt: now + 21600000, maxComparisons: 3, maxSkewMinutes: 60, usedComparisons: 0, cutoffAt: null, nextDueAt: null, sampleId: sample.id, sampleHash: "c".repeat(64), executorDigest: "d".repeat(64), reconciliationExecutorDigest: "9".repeat(64), hubspotContractDigest: "e".repeat(64), stripeContractDigest: "f".repeat(64), hubspotGrantExpiresAt: now + 86400000, stripeGrantExpiresAt: now + 86400000, mapping: sample.mapping, sampleSources: sample.sources, reviewExpiresAt: now + 60000,
    sourceGrants: { hubspot: { id: sample.sources.hubspot.grantId, revision: sample.sources.hubspot.grantVersion, digest: "e".repeat(64), executorDigest: sample.sources.hubspot.executorHash, expiresAt: now + 86400000 }, stripe: { id: sample.sources.stripe.grantId, revision: sample.sources.stripe.grantRevision, digest: "f".repeat(64), executorDigest: sample.sources.stripe.executorDigest, expiresAt: now + 86400000 } } };
}
