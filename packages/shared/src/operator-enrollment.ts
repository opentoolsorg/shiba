import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export const operatorEnrollmentDecisionSchema = z.strictObject({
  expectedOwnerAccountId: z.string().min(1).max(160),
  expectedVersion: z.number().int().positive(),
  proposalDigest: digest,
  decision: z.enum(["accept", "reject", "revoke"]),
  reviewOnly: z.literal(true),
});

/** Public, credential-free review metadata. Acceptance is never execution authority. */
export const operatorEnrollmentReviewSchema = z.strictObject({
  enrollmentId: z.string().regex(/^oe_[a-f0-9]{32}$/),
  enrollmentGeneration: z.string().uuid(),
  provenance: z.literal("operator_api_key"),
  proposalDigest: digest,
  provider: identifier,
  accountLabel: z.string().min(1).max(160),
  rawConnectionId: identifier,
  upstreamRevision: identifier,
  personalAlias: z.string().regex(/^u_[a-f0-9]{16}$/),
  deploymentEpoch: identifier,
  versionId: identifier,
  upstreamSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  manifestDigest: digest,
  operations: z.array(z.strictObject({ actionId: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/), inputSchemaHash: digest, executorHash: digest })).min(1).max(16),
  state: z.enum(["proposed", "accepted", "rejected", "revoked"]),
  version: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  decidedAt: z.number().int().positive().nullable(),
  revokedAt: z.number().int().positive().nullable(),
  executionAvailable: z.literal(false),
});

export type OperatorEnrollmentReview = z.infer<typeof operatorEnrollmentReviewSchema>;
export type OperatorEnrollmentDecision = z.infer<typeof operatorEnrollmentDecisionSchema>;

export const operatorEnrollmentDirectorySchema = z.strictObject({
  actorId: z.string().email(),
  ownerAccountId: z.string().min(1).max(160),
  enabled: z.boolean(),
  executionAvailable: z.literal(false),
  proposals: z.array(operatorEnrollmentReviewSchema).max(100),
});
