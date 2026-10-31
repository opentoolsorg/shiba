import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
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

export interface IntegrationProvider {
  readonly id: IntegrationsProviderId;
  health(): Promise<IntegrationProviderHealth>;
  listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage>;
  listConnections(args: { userId: string }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
}

export type FetchImpl = typeof fetch;
