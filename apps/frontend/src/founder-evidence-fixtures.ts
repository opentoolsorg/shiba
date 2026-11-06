import { founderEvidenceReportHash, type FounderEvidenceOptions, type FounderEvidenceReceipt, type FounderEvidenceInput, type FounderEvidencePreview, type FounderEvidenceRecord, type FounderEvidenceSummary } from "@shiba/shared";
export const EVIDENCE_WORKSPACE = `ws_${"a".repeat(24)}`;
export const EVIDENCE_LIBRARY = "founder-hubspot-stripe-reconcile";
export const EVIDENCE_BASE = `/api/founder-skills/${EVIDENCE_LIBRARY}/reports`;
export const EVIDENCE_ACTOR = "owner@example.test";
export const evidenceReceipts = (): FounderEvidenceReceipt[] => ["stripe", "hubspot"].map((providerKey, index) => ({ approvalId: `wca-evidence-${index}`, inputHash: String(index + 1).repeat(64), resultDigest: String(index + 3).repeat(64),
  employeeId: "employee-one", employeeVersion: 2, connectionId: `account-${providerKey}`, providerKey, actionId: `${providerKey}.fixture-receipt`, completedAt: Date.now() - 60_000,
  contextExpiresAt: null, sourceKind: "bounded-stored-excerpt", captureCompleteness: "unknown", datasetCompleteness: "unknown", businessSuccess: "unverified" }));
export const evidenceOptions = (selected = false): FounderEvidenceOptions => ({ ok: true, workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, actorId: EVIDENCE_ACTOR,
  authorizationMode: "local-and-connection-metadata", employees: [{ id: "employee-one", version: 2, name: "Evidence keeper" }], skill: { id: "skill-one", version: 3, name: "Evidence rules" }, receipts: selected ? evidenceReceipts() : [] });
export const evidenceInput = (): FounderEvidenceInput => ({ employeeId: "employee-one", employeeVersion: 2, skillId: "skill-one", skillVersion: 3,
  receipts: evidenceReceipts().map(({ approvalId, inputHash, resultDigest }) => ({ approvalId, inputHash, resultDigest })), expiresAt: Date.now() + 3_600_000 });
export const evidencePreview = (input = evidenceInput()): FounderEvidencePreview => {
  const receipts = evidenceReceipts().filter((item) => input.receipts.some((ref) => ref.approvalId === item.approvalId));
  const markdown = "# Stored evidence excerpts\n\nCapture completeness: unknown. Dataset completeness: unknown. Business success: unverified. No MRR, churn or reconciliation is computed.\n\n" + receipts.map((item, i) => `[R${i + 1}] ${item.providerKey} · ${item.approvalId}\n\nBounded stored excerpt. Stored result: ${i ? "empty object {}" : "null (no stored value)"}.\n`).join("\n");
  const value: FounderEvidencePreview = { ok: true as const, workspaceId: EVIDENCE_WORKSPACE, libraryId: EVIDENCE_LIBRARY, actorId: EVIDENCE_ACTOR, authorizationMode: "local-and-connection-metadata" as const,
    employeeId: input.employeeId, employeeVersion: input.employeeVersion, skillId: input.skillId, skillVersion: input.skillVersion, receipts, manifestDigest: "a".repeat(64), reportHash: "", expiresAt: input.expiresAt,
    markdown, json: JSON.stringify({ format: "shiba.founder-evidence.v1", sources: receipts.map((item, i) => ({ ...item, citation: `R${i + 1}`, storedResult: i ? {} : null })) }), canCreate: true };
  return { ...value, reportHash: founderEvidenceReportHash(value) };
};
export const evidenceRecord = (preview = evidencePreview()): FounderEvidenceRecord => ({ ...preview, id: "fer-fixture", createdAt: Date.now(), state: "active", canRead: true, canRevoke: true, canCreate: false });
export const evidenceSummary = (record = evidenceRecord()): FounderEvidenceSummary => ({ id: record.id, reportHash: record.reportHash, createdAt: record.createdAt, expiresAt: record.expiresAt,
  state: record.state, canRead: record.canRead, canRevoke: record.canRevoke, employeeId: record.employeeId, employeeVersion: record.employeeVersion, sourceCount: record.receipts.length });
