import { z } from "zod";
import { extensionScopeFieldsSchema } from "./scope.js";
import { mcpToolCatalogEntrySchema, toolPolicySchema } from "./tool-policy.js";

export const mcpTransportSchema = z.enum(["sse", "streamable-http"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpAuthTypeSchema = z.enum(["none", "bearer", "header", "oauth"]);
export type McpAuthType = z.infer<typeof mcpAuthTypeSchema>;

export const mcpOAuthStatusSchema = z.enum(["pending", "connected", "needs_reauth"]);
export type McpOAuthStatus = z.infer<typeof mcpOAuthStatusSchema>;

export const mcpAuthConfigSchema = z.object({
  bearerToken: z.string().optional(),
  headerName: z.string().optional(),
  headerValue: z.string().optional(),
});
export type McpAuthConfig = z.infer<typeof mcpAuthConfigSchema>;

/** Persisted MCP server shape. Credential-bearing fields are private to backend stores. */
export const mcpServerSchema = z.object({
  id: z.string().min(1),
  ...extensionScopeFieldsSchema.shape,
  workspaceId: z.string().optional(),
  userId: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  transport: mcpTransportSchema,
  url: z.string(),
  enabled: z.boolean(),
  authType: mcpAuthTypeSchema,
  authConfig: mcpAuthConfigSchema.optional(),
  encryptedAuthConfig: z.string().optional(),
  oauthStatus: mcpOAuthStatusSchema.optional(),
  encryptedOAuthTokens: z.string().optional(),
  encryptedOAuthClient: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthIssuer: z.string().optional(),
  oauthScope: z.string().optional(),
  oauthResource: z.string().optional(),
  oauthConnectedAt: z.number().optional(),
  oauthError: z.string().optional(),
  oauthTokenVersion: z.number().int().optional(),
  timeoutMs: z.number().optional(),
  defaultToolPolicy: toolPolicySchema.optional(),
  toolPolicies: z.record(z.string(), toolPolicySchema).optional(),
  toolCatalog: z.array(mcpToolCatalogEntrySchema).optional(),
  toolCatalogUpdatedAt: z.number().optional(),
  toolCatalogError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** Safe list projection; never includes auth configuration, OAuth material, or the full tool catalog. */
export const mcpServerListItemSchema = z.object({
  id: z.string().min(1),
  userId: z.string(),
  scope: z.enum(["personal", "workspace"]),
  archivedAt: z.number().optional(),
  archivedFromScope: z.enum(["personal", "workspace"]).optional(),
  name: z.string(),
  description: z.string().optional(),
  transport: mcpTransportSchema,
  url: z.string(),
  enabled: z.boolean(),
  authType: mcpAuthTypeSchema,
  hasAuth: z.boolean(),
  timeoutMs: z.number().optional(),
  toolCatalogCount: z.number().int().nonnegative(),
  toolCatalogUpdatedAt: z.number().optional(),
  toolCatalogError: z.string().optional(),
  defaultToolPolicy: toolPolicySchema,
  toolPolicies: z.record(z.string(), toolPolicySchema),
  oauthStatus: mcpOAuthStatusSchema.optional(),
  oauthClientId: z.string().optional(),
  oauthIssuer: z.string().optional(),
  oauthScope: z.string().optional(),
  oauthResource: z.string().optional(),
  oauthConnectedAt: z.number().optional(),
  oauthError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type McpServerListItem = z.infer<typeof mcpServerListItemSchema>;

/** Project a persisted record without spreading secret-bearing fields into a response. */
export function toMcpServerListItem(server: McpServer): McpServerListItem {
  return {
    id: server.id,
    userId: server.userId,
    scope: server.scope ?? "personal",
    ...(server.archivedAt !== undefined ? { archivedAt: server.archivedAt } : {}),
    ...(server.archivedFromScope !== undefined ? { archivedFromScope: server.archivedFromScope } : {}),
    name: server.name,
    ...(server.description !== undefined ? { description: server.description } : {}),
    transport: server.transport,
    url: server.url,
    enabled: server.enabled,
    authType: server.authType,
    hasAuth: Boolean(server.authConfig || server.encryptedAuthConfig || server.encryptedOAuthTokens || server.oauthStatus === "connected"),
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    toolCatalogCount: server.toolCatalog?.length ?? 0,
    ...(server.toolCatalogUpdatedAt !== undefined ? { toolCatalogUpdatedAt: server.toolCatalogUpdatedAt } : {}),
    ...(server.toolCatalogError !== undefined ? { toolCatalogError: server.toolCatalogError } : {}),
    defaultToolPolicy: server.defaultToolPolicy ?? "allow",
    toolPolicies: server.toolPolicies ?? {},
    ...(server.oauthStatus !== undefined ? { oauthStatus: server.oauthStatus } : {}),
    ...(server.oauthClientId !== undefined ? { oauthClientId: server.oauthClientId } : {}),
    ...(server.oauthIssuer !== undefined ? { oauthIssuer: server.oauthIssuer } : {}),
    ...(server.oauthScope !== undefined ? { oauthScope: server.oauthScope } : {}),
    ...(server.oauthResource !== undefined ? { oauthResource: server.oauthResource } : {}),
    ...(server.oauthConnectedAt !== undefined ? { oauthConnectedAt: server.oauthConnectedAt } : {}),
    ...(server.oauthError !== undefined ? { oauthError: server.oauthError } : {}),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export const mcpOAuthSessionSurfaceSchema = z.enum(["web", "desktop"]);
export type McpOAuthSessionSurface = z.infer<typeof mcpOAuthSessionSurfaceSchema>;

/** Single-use OAuth state; the PKCE verifier is stored encrypted. */
export const mcpOAuthSessionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  mcpServerId: z.string().min(1),
  encryptedCodeVerifier: z.string(),
  surface: mcpOAuthSessionSurfaceSchema,
  returnTo: z.string().optional(),
  sessionBindingHash: z.string().optional(),
  expiresAt: z.number(),
  createdAt: z.number(),
});
export type McpOAuthSession = z.infer<typeof mcpOAuthSessionSchema>;

export const mcpToolExecutionStatusSchema = z.enum(["succeeded", "failed", "denied"]);
export type McpToolExecutionStatus = z.infer<typeof mcpToolExecutionStatusSchema>;

export const mcpToolExecutionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  mcpServerId: z.string().min(1),
  toolName: z.string(),
  argumentsHash: z.string(),
  policyDecision: toolPolicySchema,
  status: mcpToolExecutionStatusSchema,
  conversationId: z.string().optional(),
  turnId: z.string().optional(),
  modelId: z.string().optional(),
  durationMs: z.number().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number(),
});
export type McpToolExecution = z.infer<typeof mcpToolExecutionSchema>;
