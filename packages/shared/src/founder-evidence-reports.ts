import { z } from "zod";
import { stableHash } from "./approvals.js";
import { founderSkillIdSchema } from "./founder-skill-library.js";

export const FOUNDER_EVIDENCE_MAX_BYTES = 262_144;
const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();
const scope = { ok: z.literal(true), workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/), libraryId: founderSkillIdSchema, actorId: z.string().min(1).max(320) };
export const founderEvidenceReceiptRefSchema = z.strictObject({ approvalId: id, inputHash: digest, resultDigest: digest });
export type FounderEvidenceReceiptRef = z.infer<typeof founderEvidenceReceiptRefSchema>;
export const founderEvidenceReceiptSchema = founderEvidenceReceiptRefSchema.extend({
  employeeId: id, employeeVersion: version, connectionId: id, providerKey: id, actionId: id,
  completedAt: z.number().int().positive(), contextExpiresAt: z.number().int().positive().nullable(),
  sourceKind: z.literal("bounded-stored-excerpt"), captureCompleteness: z.literal("unknown"),
  datasetCompleteness: z.literal("unknown"), businessSuccess: z.literal("unverified"),
});
export type FounderEvidenceReceipt = z.infer<typeof founderEvidenceReceiptSchema>;
const refs = z.array(founderEvidenceReceiptRefSchema).min(1).max(8).refine((values) => new Set(values.map((item) => item.approvalId)).size === values.length);
const receipts = z.array(founderEvidenceReceiptSchema).min(1).max(8).refine((values) => new Set(values.map((item) => item.approvalId)).size === values.length);
export const founderEvidenceInputSchema = z.strictObject({ employeeId: id, employeeVersion: version, skillId: id, skillVersion: version,
  receipts: refs, expiresAt: z.number().int().positive() });
export type FounderEvidenceInput = z.infer<typeof founderEvidenceInputSchema>;
export const founderEvidenceCreateInputSchema = founderEvidenceInputSchema.extend({ expectedReportHash: digest, requestId: z.string().uuid() });
export const founderEvidenceOptionsSchema = z.object({ ...scope,
  authorizationMode: z.literal("local-and-connection-metadata"),
  employees: z.array(z.object({ id, version, name: z.string().min(1).max(200) })).max(100),
  skill: z.object({ id, version, name: z.string().min(1).max(200) }).nullable(), receipts: z.array(founderEvidenceReceiptSchema).max(100),
});
export type FounderEvidenceOptions = z.infer<typeof founderEvidenceOptionsSchema>;
const previewShape = { ...scope, authorizationMode: z.literal("local-and-connection-metadata"),
  employeeId: id, employeeVersion: version, skillId: id, skillVersion: version, receipts,
  manifestDigest: digest, reportHash: digest, expiresAt: z.number().int().positive(),
  markdown: z.string().max(FOUNDER_EVIDENCE_MAX_BYTES), json: z.string().max(FOUNDER_EVIDENCE_MAX_BYTES), canCreate: z.boolean(),
};
function boundedContent(value: { markdown: string; json: string }): boolean {
  return new TextEncoder().encode(value.markdown).length + new TextEncoder().encode(value.json).length <= FOUNDER_EVIDENCE_MAX_BYTES;
}
export const founderEvidencePreviewSchema = z.object(previewShape).refine(boundedContent, "Stored evidence exceeds the report size limit.");
export type FounderEvidencePreview = z.infer<typeof founderEvidencePreviewSchema>;
export const founderEvidenceRecordSchema = z.object({ ...previewShape, id, createdAt: z.number().int().positive(),
  state: z.enum(["active", "revoked"]), canRead: z.boolean(), canRevoke: z.boolean() }).refine(boundedContent);
export type FounderEvidenceRecord = z.infer<typeof founderEvidenceRecordSchema>;
export const founderEvidenceSummarySchema = z.object({ id, reportHash: digest, createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  state: z.enum(["active", "revoked"]), canRead: z.boolean(), canRevoke: z.boolean(), employeeId: id, employeeVersion: version,
  sourceCount: z.number().int().min(1).max(8), unavailableReason: z.string().max(200).optional() });
export type FounderEvidenceSummary = z.infer<typeof founderEvidenceSummarySchema>;
export const founderEvidenceListSchema = z.object({ ...scope, reports: z.array(founderEvidenceSummarySchema).max(100) });
export type FounderEvidenceList = z.infer<typeof founderEvidenceListSchema>;
export const founderEvidenceRevokeInputSchema = z.strictObject({ expectedReportHash: digest });
export const founderEvidenceRevokeResponseSchema = z.object({ ...scope, report: founderEvidenceSummarySchema });

/** SHA-256 of the exact primitive JSON array; no DOM or provider dependency. */
export function founderEvidenceReportHash(value: { manifestDigest: string; expiresAt: number; markdown: string; json: string }): string {
  return stableHash(["shiba.founder-evidence.v1", value.manifestDigest, value.expiresAt, value.markdown, value.json]);
}
