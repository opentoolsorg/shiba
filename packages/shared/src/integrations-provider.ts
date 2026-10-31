import { z } from "zod";
import { integrationDomainSchema, integrationKindSchema, integrationPrioritySchema } from "./integration-catalog.js";

export const integrationsProviderIdSchema = z.enum(["composio", "none", "grokbot"]);
export type IntegrationsProviderId = z.infer<typeof integrationsProviderIdSchema>;

export const integrationProviderHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "unavailable",
  "unconfigured",
]);
export type IntegrationProviderHealthStatus = z.infer<typeof integrationProviderHealthStatusSchema>;

export const integrationProviderHealthSchema = z.object({
  provider: integrationsProviderIdSchema,
  status: integrationProviderHealthStatusSchema,
  checkedAt: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type IntegrationProviderHealth = z.infer<typeof integrationProviderHealthSchema>;

export const integrationProviderCatalogItemSchema = z.object({
  id: z.string().min(1),
  providerKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  logoUrl: z.string().url().nullable().optional(),
  domain: integrationDomainSchema.optional(),
  kind: integrationKindSchema.optional(),
  priority: integrationPrioritySchema.optional(),
  docsUrl: z.string().url().optional(),
  isConnected: z.boolean(),
  connectionId: z.string().nullable().optional(),
  source: z.enum(["composio", "static", "grokbot", "native"]),
  connectable: z.boolean(),
});
export type IntegrationProviderCatalogItem = z.infer<typeof integrationProviderCatalogItemSchema>;

export const integrationProviderCatalogPageSchema = z.object({
  ok: z.literal(true),
  provider: integrationsProviderIdSchema,
  items: z.array(integrationProviderCatalogItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  fallbackCatalog: z.boolean().optional(),
});
export type IntegrationProviderCatalogPage = z.infer<typeof integrationProviderCatalogPageSchema>;

export const integrationProviderConnectionSchema = z.object({
  id: z.string().min(1),
  providerKey: z.string().min(1),
  provider: integrationsProviderIdSchema,
  identityLabel: z.string().nullable().optional(),
});
export type IntegrationProviderConnection = z.infer<typeof integrationProviderConnectionSchema>;

export const integrationProviderConnectionsResponseSchema = z.object({
  ok: z.literal(true),
  provider: integrationsProviderIdSchema,
  connections: z.array(integrationProviderConnectionSchema),
});
export type IntegrationProviderConnectionsResponse = z.infer<
  typeof integrationProviderConnectionsResponseSchema
>;

export const integrationProviderMetaSchema = z.object({
  ok: z.literal(true),
  provider: integrationsProviderIdSchema,
  health: integrationProviderHealthSchema,
});
export type IntegrationProviderMeta = z.infer<typeof integrationProviderMetaSchema>;

export const integrationProviderBeginConnectResponseSchema = z.object({
  ok: z.boolean(),
  provider: integrationsProviderIdSchema,
  redirectUrl: z.string().url().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type IntegrationProviderBeginConnectResponse = z.infer<
  typeof integrationProviderBeginConnectResponseSchema
>;

export const INTEGRATIONS_PROVIDER_PAGE_SIZE_DEFAULT = 8;

/** BroadcastChannel + postMessage type for Composio OAuth popup completion. */
export const SHIBA_INTEGRATIONS_OAUTH_CHANNEL = "shiba-integrations-oauth";

export const integrationProviderExecuteRequestSchema = z.object({
  toolSlug: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  toolkitSlug: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  connectedAccountId: z.string().min(1).optional(),
});
export type IntegrationProviderExecuteRequest = z.infer<typeof integrationProviderExecuteRequestSchema>;

export const integrationProviderExecuteResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["completed", "failed"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
  sessionId: z.string().optional(),
});
export type IntegrationProviderExecuteResponse = z.infer<typeof integrationProviderExecuteResponseSchema>;

export const integrationProviderSessionResponseSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type IntegrationProviderSessionResponse = z.infer<typeof integrationProviderSessionResponseSchema>;

export function parseIntegrationsProviderId(raw: string | undefined): IntegrationsProviderId {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "composio" || normalized === "none" || normalized === "grokbot") {
    return normalized;
  }
  return "composio";
}
