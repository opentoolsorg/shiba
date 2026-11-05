import { z } from "zod";
import { founderSkillIdSchema } from "./founder-skill-library.js";
import { slackInstallationSnapshotSchema } from "./slack-installations.js";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().positive();
export const REPORT_SLACK_MAX_BYTES = 3_500;
export const REPORT_SLACK_TTL_MS = 15 * 60_000;
export const REPORT_SLACK_DISCLOSURE_SCOPE = "all-people-with-access-to-selected-slack-channel-thread" as const;
export const reportSlackDestinationSchema = z.strictObject({
  roomId: id, roomTitle: z.string().min(1).max(200), linkId: id,
  teamId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  threadTs: z.string().regex(/^\d{1,20}\.\d{1,20}$/), ownerId: z.string().min(1).max(320),
  roomAudienceIds: z.array(z.string().min(1).max(320)).min(1).max(17),
  installation: slackInstallationSnapshotSchema.optional(),
});
export type ReportSlackDestination = z.infer<typeof reportSlackDestinationSchema>;
export const reportSlackPrepareSchema = z.strictObject({
  requestId: z.string().uuid(), reportHash: hash, roomId: id, linkId: id, expiresAt: timestamp,
});
export type ReportSlackPrepare = z.infer<typeof reportSlackPrepareSchema>;
export const reportSlackDecisionSchema = z.strictObject({
  expectedVersion: z.literal(1), digest: hash, contentHash: hash, expiresAt: timestamp, reviewed: z.literal(true),
});
export type ReportSlackDecision = z.infer<typeof reportSlackDecisionSchema>;
export const reportSlackDisclosureSchema = reportSlackDecisionSchema.extend({
  disclosureConsent: z.literal("share-report-to-configured-slack-thread"),
  audienceConsent: z.literal(REPORT_SLACK_DISCLOSURE_SCOPE),
});
export type ReportSlackDisclosure = z.infer<typeof reportSlackDisclosureSchema>;
export const reportSlackIntentSchema = z.strictObject({
  id, version: z.literal(1), digest: hash, reportHash: hash, sourceHash: hash,
  disclosureScope: z.literal(REPORT_SLACK_DISCLOSURE_SCOPE),
  content: z.string().min(1).max(REPORT_SLACK_MAX_BYTES), contentHash: hash,
  creatorId: z.string().min(1).max(320), creatorAccountId: id, destination: reportSlackDestinationSchema,
  createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["draft", "disclosed", "sending", "sent", "blocked", "failed", "unknown", "cancelled", "expired"]),
  disclosedAt: timestamp.nullable(), approvedByUserId: z.string().max(320).nullable(), receiptTs: z.string().max(100).nullable(),
  errorCode: z.string().max(100).nullable(), canDisclose: z.boolean(), canApprove: z.boolean(), canCancel: z.boolean(),
});
export type ReportSlackIntent = z.infer<typeof reportSlackIntentSchema>;
export const reportSlackStateSchema = z.strictObject({
  ok: z.literal(true), workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/), libraryId: founderSkillIdSchema,
  reportId: id, actorId: z.string().min(1).max(320), available: z.boolean(), unavailableReason: z.string().max(100).optional(),
  destinations: z.array(reportSlackDestinationSchema).max(50), intents: z.array(reportSlackIntentSchema).max(50),
});
export type ReportSlackState = z.infer<typeof reportSlackStateSchema>;
