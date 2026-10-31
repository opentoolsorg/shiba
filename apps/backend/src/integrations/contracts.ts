import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
  IntegrationProviderSessionResponse,
  IntegrationsProviderId,
} from "@shiba/shared";

export interface IntegrationCatalogQuery {
  cursor?: string;
  limit: number;
  query?: string;
  userId: string;
}

export interface IntegrationCatalogPage {
  items: IntegrationProviderCatalogItem[];
  nextCursor: string | null;
  hasMore: boolean;
  fallbackCatalog?: boolean;
}

export interface IntegrationConnectContext {
  callbackOrigin: string;
  providerKey: string;
  userId: string;
}

export interface IntegrationExecuteContext {
  userId: string;
  toolSlug: string;
  arguments: Record<string, unknown>;
  toolkitSlug?: string;
  sessionId?: string;
  connectedAccountId?: string;
}

export interface IntegrationProvider {
  readonly id: IntegrationsProviderId;
  health(): Promise<IntegrationProviderHealth>;
  listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage>;
  listConnections(args: { userId: string }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
  createToolRouterSession?(args: {
    userId: string;
    toolkitSlugs: string[];
  }): Promise<IntegrationProviderSessionResponse>;
  executeTool?(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse>;
}

export type FetchImpl = typeof fetch;
