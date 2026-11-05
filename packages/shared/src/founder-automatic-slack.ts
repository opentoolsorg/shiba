import { z } from "zod";
import { founderSkillIdSchema } from "./founder-skill-library.js";
import {
  reportSlackDestinationSchema,
  REPORT_SLACK_DISCLOSURE_SCOPE,
  REPORT_SLACK_MAX_BYTES,
} from "./report-slack.js";
import { founderAutomaticReadContractSchema } from "./founder-automatic-reads.js";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().positive();
export const AUTOMATIC_SLACK_RENDER_POLICY = "complete-qualified-markdown.v1" as const;
export const AUTOMATIC_SLACK_COMPACT_RENDER_POLICY = "complete-qualified-compact-json.v2" as const;
export const AUTOMATIC_SLACK_MAX_TTL_MS = 28 * 86_400_000;
export const AUTOMATIC_SLACK_FUTURE_CONSENT =
  "share-future-completed-reports-from-this-exact-read-grant" as const;
export const AUTOMATIC_SLACK_AUDIENCE_CONSENT =
  "all-current-and-future-people-with-access-to-selected-slack-channel-thread" as const;
export const automaticSlackPrepareSchema = z.strictObject({
  requestId: z.string().uuid(),
  readGrantId: id,
  readGrantVersion: z.number().int().positive(),
  sampleOccurrenceId: id,
  sampleReportHash: hash,
  roomId: id,
  linkId: id,
  maxSends: z.number().int().min(1).max(10),
  expiresAt: time,
});
export type AutomaticSlackPrepare = z.infer<typeof automaticSlackPrepareSchema>;
export const automaticSlackDecisionSchema = z.strictObject({
  expectedVersion: z.literal(1),
  digest: hash,
  expiresAt: time,
  reviewed: z.literal(true),
});
export type AutomaticSlackDecision = z.infer<typeof automaticSlackDecisionSchema>;
export const automaticSlackDisclosureSchema = automaticSlackDecisionSchema.extend({
  futureReportConsent: z.literal(AUTOMATIC_SLACK_FUTURE_CONSENT),
  audienceConsent: z.literal(AUTOMATIC_SLACK_AUDIENCE_CONSENT),
});
export const automaticSlackGrantSchema = z.strictObject({
  id,
  version: z.literal(1),
  digest: hash,
  readGrantId: id,
  readGrantVersion: z.number().int().positive(),
  readGrantDigest: hash,
  readContract: founderAutomaticReadContractSchema,
  ownerId: z.string().max(320),
  ownerAccountId: id,
  destination: reportSlackDestinationSchema,
  renderPolicy: z.enum([AUTOMATIC_SLACK_RENDER_POLICY, AUTOMATIC_SLACK_COMPACT_RENDER_POLICY]),
  maxBytes: z.literal(REPORT_SLACK_MAX_BYTES),
  disclosureScope: z.literal(REPORT_SLACK_DISCLOSURE_SCOPE),
  futureAudienceScope: z.literal(AUTOMATIC_SLACK_AUDIENCE_CONSENT),
  sampleOccurrenceId: id,
  sampleReportHash: hash,
  sampleContent: z.string().max(REPORT_SLACK_MAX_BYTES).nullable(),
  sampleExpiresAt: time.nullable(),
  state: z.enum([
    "draft",
    "disclosed",
    "enabled",
    "paused",
    "revoked",
    "blocked",
    "exhausted",
    "expired",
  ]),
  createdAt: time,
  expiresAt: time,
  reviewExpiresAt: time,
  approvedAt: time.nullable(),
  approvedByUserId: z.string().max(320).nullable(),
  maxSends: z.number().int().min(1).max(10),
  usedSends: z.number().int().nonnegative(),
  errorCode: z.string().max(100).nullable(),
  canDisclose: z.boolean(),
  canApprove: z.boolean(),
  canPause: z.boolean(),
  canRevoke: z.boolean(),
});
export type AutomaticSlackGrant = z.infer<typeof automaticSlackGrantSchema>;
export const automaticSlackDeliverySchema = z.strictObject({
  id,
  grantId: id,
  occurrenceId: id,
  reportHash: hash,
  contentHash: hash,
  content: z.string().max(REPORT_SLACK_MAX_BYTES),
  state: z.enum(["sending", "sent", "blocked", "failed", "unknown"]),
  createdAt: time,
  expiresAt: time,
  receiptTs: z.string().max(100).nullable(),
  errorCode: z.string().max(100).nullable(),
});
export type AutomaticSlackDelivery = z.infer<typeof automaticSlackDeliverySchema>;
export const automaticSlackStateSchema = z.strictObject({
  ok: z.literal(true),
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  libraryId: founderSkillIdSchema,
  actorId: z.string().max(320),
  available: z.boolean(),
  unavailableReason: z.string().max(100).nullable(),
  destinations: z.array(reportSlackDestinationSchema).max(50),
  grants: z.array(automaticSlackGrantSchema).max(20),
  deliveries: z.array(automaticSlackDeliverySchema).max(50),
});
export type AutomaticSlackState = z.infer<typeof automaticSlackStateSchema>;
