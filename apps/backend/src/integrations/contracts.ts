import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
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

export interface IntegrationAction {
  id: string;
  service: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface IntegrationActionQuery {
  userId: string;
  toolkitSlug: string;
  query?: string;
  actionId?: string;
  limit: number;
}

export interface IntegrationProvider {
  searchActions?(query: IntegrationActionQuery): Promise<IntegrationAction[]>;
  readonly id: IntegrationsProviderId;
  health(): Promise<IntegrationProviderHealth>;
  listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage>;
  listConnections(args: { userId: string }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
  executeTool?(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse>;
}

export type FetchImpl = typeof fetch;
