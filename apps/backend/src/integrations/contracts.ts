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
  /** Internal employee-grant binding. Never accepted from an action's model arguments. */
  approvedConnectionId?: string;
  /** Trusted Worker-only authority/cancellation recheck after provider preflight, never a wire argument. */
  beforeDispatch?: () => Promise<void>;
  /** Trusted task signal, checked synchronously at the final send boundary. */
  signal?: AbortSignal;
  /** Frozen human consent deadline. Internal only; never accepted from model or API arguments. */
  approvedUntil?: number;
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
  listConnections(args: { userId: string; includeUnavailable?: boolean }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
  executeTool?(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse>;
}

export type FetchImpl = typeof fetch;
