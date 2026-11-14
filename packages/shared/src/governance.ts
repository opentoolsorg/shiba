import { z } from "zod";

/** Resource kinds WS05–WS08 integrate against. */
export const governanceResourceKindSchema = z.enum(["room", "file", "note", "task", "chat"]);
export type GovernanceResourceKind = z.infer<typeof governanceResourceKindSchema>;

export const governanceAccessLevelSchema = z.enum(["view", "comment", "edit", "manage"]);
export type GovernanceAccessLevel = z.infer<typeof governanceAccessLevelSchema>;

export const governancePrincipalKindSchema = z.enum(["user", "group", "guest"]);
export type GovernancePrincipalKind = z.infer<typeof governancePrincipalKindSchema>;

const ACCESS_RANK: Record<GovernanceAccessLevel, number> = {
  view: 1,
  comment: 2,
  edit: 3,
  manage: 4,
};

export function governanceAccessSatisfies(
  granted: GovernanceAccessLevel,
  required: GovernanceAccessLevel,
): boolean {
  return ACCESS_RANK[granted] >= ACCESS_RANK[required];
}

export const governanceActorSchema = z.object({
  workspaceId: z.string(),
  userId: z.string().email().or(z.string().min(1)),
  membershipRole: z.enum(["owner", "admin", "member"]).optional(),
  membershipVersion: z.number().int().positive().optional(),
  guestId: z.string().optional(),
});

export type GovernanceActor = z.infer<typeof governanceActorSchema>;

export interface CanAccessInput {
  actor: GovernanceActor;
  resourceKind: GovernanceResourceKind;
  resourceId: string;
  access: GovernanceAccessLevel;
}

export type CanAccessReason =
  | "workspace_role"
  | "member_default"
  | "group_grant"
  | "direct_grant"
  | "guest_grant"
  | "denied";

export interface CanAccessResult {
  allowed: boolean;
  reason: CanAccessReason;
  /** Membership version observed during the check (for CAS callers). */
  membershipVersion?: number;
}

export const workspaceGroupSchema = z.object({
  groupId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.number().int(),
});

export type WorkspaceGroup = z.infer<typeof workspaceGroupSchema>;

export const workspaceSharingPolicySchema = z.object({
  workspaceId: z.string(),
  publicLinksAllowed: z.boolean(),
  guestInvitesAllowed: z.boolean(),
  defaultResourceAccess: governanceAccessLevelSchema.nullable(),
  version: z.number().int().positive(),
});

export type WorkspaceSharingPolicy = z.infer<typeof workspaceSharingPolicySchema>;

export const shareLinkSummarySchema = z.object({
  linkId: z.string(),
  resourceKind: governanceResourceKindSchema,
  resourceId: z.string(),
  createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});

export type ShareLinkSummary = z.infer<typeof shareLinkSummarySchema>;
