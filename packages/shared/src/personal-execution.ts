import { z } from "zod";
import { stableHash } from "./approvals.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).refine((value) => value === value.toLowerCase());
export const personalAccountReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  harness: z.enum(["claude-code", "codex"]),
  billingMode: z.literal("native-subscription"),
  accountFingerprint: digest,
  authVersion: digest,
  cliVersion: z.string().min(1).max(100),
  probeMethod: z.enum(["claude-auth-status", "codex-account-read"]),
  probedAt: z.number().int().positive(),
}).refine((value) => value.probeMethod === (value.harness === "claude-code" ? "claude-auth-status" : "codex-account-read"));
export type PersonalAccountReceipt = z.infer<typeof personalAccountReceiptSchema>;
export interface PersonalAccountEvidence extends PersonalAccountReceipt { receivedAt: number }

export const personalPairingScopeSchema = z.strictObject({
  version: z.literal(2),
  ownerAccountId: z.string().min(1).max(128),
  actorId: actor,
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  membershipVersion: z.number().int().positive(),
  membershipRole: z.enum(["owner", "admin", "member"]),
  origin: z.string().url().refine((value) => new URL(value).origin === value && new URL(value).protocol === "https:"),
});
export type PersonalPairingScope = z.infer<typeof personalPairingScopeSchema>;

export const personalExecutionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  grantId: z.string().regex(/^plex_[a-f0-9]{32}$/),
  grantVersion: z.number().int().positive(),
  ownerAccountId: z.string().min(1).max(128),
  actorId: actor,
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  membershipVersion: z.number().int().positive(),
  machineId: z.string().min(1).max(64),
  machineRevision: z.number().int().positive(),
  harness: z.enum(["claude-code", "codex"]),
  billingMode: z.literal("native-subscription"),
  accountFingerprint: digest,
  authVersion: digest,
  codingModel: z.string().min(3).max(200).regex(/^(?:anthropic|openai)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  repoUrl: z.string().max(512).regex(/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  expiresAt: z.number().int().positive(),
  allowedPhases: z.tuple([z.literal("local_repository_task")]),
}).refine((value) => value.codingModel.startsWith(value.harness === "claude-code" ? "anthropic/" : "openai/"));
export type PersonalExecutionSnapshot = z.infer<typeof personalExecutionSnapshotSchema>;
export const personalExecutionClaimSchema = z.strictObject({
  snapshot: personalExecutionSnapshotSchema,
  approvalId: z.string().min(1).max(200),
  inputHash: digest,
  generation: z.number().int().nonnegative(),
  executionOwner: z.string().min(1).max(1024),
  handoffId: z.string().min(1).max(128),
  contextDigest: digest,
  approvedUntil: z.number().int().positive(),
});
export type PersonalExecutionClaim = z.infer<typeof personalExecutionClaimSchema>;
export interface PersonalComputerBinding { version: 1; revision: number; scope: PersonalPairingScope; accounts: readonly PersonalAccountEvidence[] }
/** No account tokens, user email or credential file contents are in daemon receipts. */
export const PERSONAL_ACCOUNT_MAX_AGE_MS = 75_000;
export const PERSONAL_CONTROL_BODY_LIMIT = 16_384;
export const PERSONAL_EVENTS_BODY_LIMIT = 1_048_576;
export const PERSONAL_RESULT_BODY_LIMIT = 8_388_608;

/** Bind the daemon's executable context to the immutable human-reviewed run. */
export function personalExecutionContextDigest(input: {
  handoffId: string; task: string; baseBranch: string;
  customAgentId?: string; customAgentVersion?: number;
  skillPins?: readonly { skillId: string; version: number; name: string; sourceUrl?: string }[];
  expectedDeliverables?: readonly string[];
}): string {
  return stableHash({
    handoffId: input.handoffId, task: input.task, baseBranch: input.baseBranch,
    customAgentId: input.customAgentId ?? null, customAgentVersion: input.customAgentVersion ?? null,
    skillPins: (input.skillPins ?? []).map((pin) => ({ skillId: pin.skillId, version: pin.version, name: pin.name, sourceUrl: pin.sourceUrl ?? null })),
    expectedDeliverables: [...(input.expectedDeliverables ?? [])],
  });
}
