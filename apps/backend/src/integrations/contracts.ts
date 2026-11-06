import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
  IntegrationProviderSetupState,
  IntegrationActionOperationType,
  IntegrationsProviderId,
} from "@shiba/shared";

export interface IntegrationCatalogQuery {
  /** Server-derived workspace sharing scope; absent retains the personal alias. */
  workspaceId?: string;
  cursor?: string;
  limit: number;
  query?: string;
  readiness?: IntegrationProviderSetupState;
  userId: string;
}

export interface IntegrationCatalogPage {
  items: IntegrationProviderCatalogItem[];
  nextCursor: string | null;
  hasMore: boolean;
  fallbackCatalog?: boolean;
  total?: number;
  oauthCapable?: number;
}

export interface IntegrationConnectContext {
  workspaceId?: string;
  callbackOrigin: string;
  providerKey: string;
  userId: string;
  /** Replace only a non-active owned row (expired, revoked or unconfigured) with fresh consent. */
  replaceUnavailable?: boolean;
}

export interface IntegrationExecuteContext {
  workspaceId?: string;
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
  /** Advisory provider declaration. Missing means unclassified; never authorizes execution. */
  operationType?: IntegrationActionOperationType;
}

export interface IntegrationActionQuery {
  workspaceId?: string;
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
  listConnections(args: { userId: string; includeUnavailable?: boolean; workspaceId?: string }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
  executeTool?(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse>;
}

export type FetchImpl = typeof fetch;
