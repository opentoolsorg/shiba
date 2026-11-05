import { z } from "zod";

export const workspaceIntegrationConnectionSchema = z.object({
  id: z.string(), scope: z.literal("workspace"), workspaceId: z.string(), providerKey: z.string(),
  version: z.number().int().positive(), generation: z.number().int().positive(),
  state: z.enum(["pending", "active", "revoking", "revoked", "unknown", "error"]),
  identityLabel: z.string().nullable(), authorizationFingerprint: z.string().nullable(),
  upstreamReady: z.boolean(), health: z.enum(["unknown", "error"]), grantCount: z.number().int().nonnegative(),
});
export type WorkspaceIntegrationConnection = z.infer<typeof workspaceIntegrationConnectionSchema>;
export const workspaceIntegrationConnectionsResponseSchema = z.object({
  ok: z.literal(true), workspaceId: z.string(), canManage: z.boolean(), connections: z.array(workspaceIntegrationConnectionSchema),
});
export type WorkspaceIntegrationConnectionsResponse = z.infer<typeof workspaceIntegrationConnectionsResponseSchema>;
export const workspaceIntegrationConnectionResponseSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), connection: workspaceIntegrationConnectionSchema });
export type WorkspaceIntegrationConnectionResponse = z.infer<typeof workspaceIntegrationConnectionResponseSchema>;
export const workspaceIntegrationConnectResponseSchema = z.object({
  ok: z.literal(true), workspaceId: z.string(), connection: workspaceIntegrationConnectionSchema,
  pendingId: z.string(), authorizationFingerprint: z.string(), redirectUrl: z.string(),
});
export type WorkspaceIntegrationConnectResponse = z.infer<typeof workspaceIntegrationConnectResponseSchema>;
export const workspaceIntegrationGrantSchema = z.object({
  id: z.string(), version: z.number().int().positive(), employeeId: z.string(), employeeVersion: z.number().int().positive(),
  actorId: z.string(), actorMembershipVersion: z.number().int().positive(),
  permissions: z.array(z.enum(["discover", "execute"])).max(2), state: z.enum(["active", "revoked"]),
});
export type WorkspaceIntegrationGrant = z.infer<typeof workspaceIntegrationGrantSchema>;
export const workspaceIntegrationGrantsResponseSchema = z.object({
  ok: z.literal(true), workspaceId: z.string(), connectionId: z.string(), connectionVersion: z.number().int().positive(),
  employees: z.array(z.object({ id: z.string(), name: z.string(), version: z.number().int().positive() })),
  actors: z.array(z.object({ userId: z.string(), role: z.enum(["owner", "admin", "member"]), version: z.number().int().positive() })),
  grants: z.array(workspaceIntegrationGrantSchema),
});
export type WorkspaceIntegrationGrantsResponse = z.infer<typeof workspaceIntegrationGrantsResponseSchema>;
/** Provider-declared metadata, never a read-only guarantee or approval grant. */
export const integrationActionOperationTypeSchema = z.enum(["read", "write", "destructive", "unclassified"]);
export type IntegrationActionOperationType = z.infer<typeof integrationActionOperationTypeSchema>;
export const workspaceIntegrationActionSchema = z.object({ id: z.string(), service: z.string(), name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()).optional(),
  // Optional preserves older wire responses; absent means unclassified.
  operationType: integrationActionOperationTypeSchema.catch("unclassified").optional() });
export const workspaceIntegrationActionsResponseSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), connectionId: z.string(), actions: z.array(workspaceIntegrationActionSchema) });
export type WorkspaceIntegrationActionsResponse = z.infer<typeof workspaceIntegrationActionsResponseSchema>;
export const workspaceIntegrationApprovalSchema = z.object({
  id: z.string(), requesterId: z.string(), employeeId: z.string(), employeeVersion: z.number().int().positive(), employeeName: z.string(),
  connectionId: z.string(), connectionVersion: z.number().int().positive(), actionId: z.string(), arguments: z.record(z.string(), z.unknown()), inputHash: z.string(),
  status: z.enum(["pending", "approved", "denied", "executing", "completed", "failed", "unknown", "expired"]),
  expiresAt: z.number(), canDecide: z.boolean(), canExecute: z.boolean(), result: z.unknown().nullable(), error: z.string().nullable(),
});
export type WorkspaceIntegrationApproval = z.infer<typeof workspaceIntegrationApprovalSchema>;
export const workspaceIntegrationApprovalsResponseSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), approvals: z.array(workspaceIntegrationApprovalSchema), approvalId: z.string().optional() });
export type WorkspaceIntegrationApprovalsResponse = z.infer<typeof workspaceIntegrationApprovalsResponseSchema>;
