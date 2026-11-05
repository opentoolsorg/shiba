import { z } from "zod";
import { personalExecutionSnapshotSchema } from "./personal-execution.js";

export const SLACK_COWORKER_ROOM_CONSENT =
  "share-my-slack-task-and-results-with-reviewed-room-audience" as const;
const draftId = z.string().regex(/^sd_[a-f0-9]{32}$/),
  previewId = z.string().regex(/^scp_[a-f0-9]{32}$/);
const roomId = z.string().regex(/^room_[a-f0-9]{24}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().safe().positive();
export const slackCoworkerSubmissionSelectionSchema = z.strictObject({
  requestId: z.string().uuid(),
  id: draftId,
  roomId,
  recipientActorId: z.string().regex(/^agent:[A-Za-z0-9_-]{1,100}$/),
  personalExecution: z.strictObject({
    grantId: z.string().regex(/^plex_[a-f0-9]{32}$/),
    expectedVersion: z.number().int().positive(),
  }),
});
export type SlackCoworkerSubmissionSelection = z.infer<
  typeof slackCoworkerSubmissionSelectionSchema
>;
export const slackCoworkerSubmissionPreviewSchema = z.strictObject({
  previewId,
  draftId,
  digest: hash,
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  actorId: z.string().email(),
  task: z.string().min(1).max(4000),
  roomId,
  roomTitle: z.string().min(1).max(200),
  recipientActorId: z.string().regex(/^agent:[A-Za-z0-9_-]{1,100}$/),
  employeeName: z.string().min(1).max(200),
  employeeVersion: z.number().int().positive(),
  personalExecution: personalExecutionSnapshotSchema,
  roomAudience: z
    .array(
      z.strictObject({
        actorId: z.string().min(1).max(320),
        userId: z.string().min(1).max(320),
        kind: z.enum(["human", "agent"]),
        role: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(50),
  createdAt: time,
  expiresAt: time,
  consent: z.literal(SLACK_COWORKER_ROOM_CONSENT),
});
export type SlackCoworkerSubmissionPreview = z.infer<typeof slackCoworkerSubmissionPreviewSchema>;
export const slackCoworkerSubmissionDecisionSchema = z.strictObject({
  previewId,
  digest: hash,
  reviewed: z.literal(true),
  audienceConsent: z.literal(SLACK_COWORKER_ROOM_CONSENT),
});
export type SlackCoworkerSubmissionDecision = z.infer<typeof slackCoworkerSubmissionDecisionSchema>;
export const slackCoworkerSubmissionReceiptSchema = z.strictObject({
  previewId,
  draftId,
  roomId,
  handoffId: z.string().regex(/^scx_[a-f0-9]{32}$/),
  state: z.enum(["dispatching", "queuing", "queued", "blocked", "unknown"]),
  approvalRequired: z.literal(true),
});
export type SlackCoworkerSubmissionReceipt = z.infer<typeof slackCoworkerSubmissionReceiptSchema>;
const scope = {
  ok: z.literal(true),
  workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/),
  actorId: z.string().email(),
};
export const slackCoworkerSubmissionPreviewResponseSchema = z.strictObject({
  ...scope,
  preview: slackCoworkerSubmissionPreviewSchema,
});
export const slackCoworkerSubmissionReceiptResponseSchema = z.strictObject({
  ...scope,
  receipt: slackCoworkerSubmissionReceiptSchema,
});
export const slackCoworkerSubmissionStateSchema = z.strictObject({
  ...scope,
  preview: slackCoworkerSubmissionPreviewSchema.nullable(),
  receipt: slackCoworkerSubmissionReceiptSchema.nullable(),
  sourceAvailable: z.boolean(),
  unavailableReason: z.string().max(100).optional(),
});
export type SlackCoworkerSubmissionState = z.infer<typeof slackCoworkerSubmissionStateSchema>;
export const slackCoworkerSubmissionListSchema = z.strictObject({
  ...scope,
  submissions: z.array(slackCoworkerSubmissionReceiptSchema).max(100),
});
