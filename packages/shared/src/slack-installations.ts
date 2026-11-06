import { z } from "zod";

export const SLACK_BOT_SCOPES = ["chat:write", "app_mentions:read", "commands", "chat:write.customize", "channels:history", "groups:history", "im:history", "mpim:history"] as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const slackInstallationStartSchema = z.strictObject({ requestId: z.string().uuid(),
  scopes: z.array(z.enum(SLACK_BOT_SCOPES)).min(1).max(SLACK_BOT_SCOPES.length).refine((values) => new Set(values).size === values.length && values.includes("chat:write")),
  consent: z.literal("install-bot-in-selected-slack-workspace"),
});
export type SlackInstallationStart = z.infer<typeof slackInstallationStartSchema>;
export const slackInstallationDecisionSchema = z.strictObject({ expectedVersion: z.number().int().positive(), digest: hash, reviewed: z.literal(true) });
export type SlackInstallationDecision = z.infer<typeof slackInstallationDecisionSchema>;
export const slackInstallationSnapshotSchema = z.strictObject({
  id, workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/), ownerId: z.string().min(1).max(320), ownerAccountId: id,
  ownerMembershipVersion: z.number().int().positive(), appId: id, teamId: id, enterpriseId: z.null(), botUserId: id, botId: id,
  installerSlackUserId: id,
  generation: z.number().int().positive(), version: z.number().int().positive(), tokenRevision: z.number().int().positive(),
  scopes: z.array(z.enum(SLACK_BOT_SCOPES)).min(1).max(SLACK_BOT_SCOPES.length), expiresAt: z.number().int().positive().nullable(),
});
export type SlackInstallationSnapshot = z.infer<typeof slackInstallationSnapshotSchema>;
export const slackInstallationPublicSchema = slackInstallationSnapshotSchema.extend({
  state: z.enum(["pending", "active", "refreshing", "revoked", "unknown", "blocked"]), digest: hash,
  activationExpiresAt: z.number().int().positive(), createdAt: z.number().int().positive(),
  canActivate: z.boolean(), canRevoke: z.boolean(), canRefresh: z.boolean(),
});
export type SlackInstallationPublic = z.infer<typeof slackInstallationPublicSchema>;
export const slackInstallationStateSchema = z.strictObject({ ok: z.literal(true), workspaceId: z.string().regex(/^ws_[a-f0-9]{24}$/), actorId: z.string().min(1).max(320),
  available: z.boolean(), unavailableReason: z.string().max(100).optional(), installations: z.array(slackInstallationPublicSchema).max(16),
  executionAvailable: z.literal(false), executionUnavailableReason: z.literal("native_slack_actor_and_provider_billing_grant_required"),
});
export type SlackInstallationState = z.infer<typeof slackInstallationStateSchema>;
