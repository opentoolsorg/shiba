import type {
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderSetupState,
  IntegrationActionOperationType,
} from "@shiba/shared";

export interface IntegrationCatalogQuery {
  /** Server-derived workspace sharing scope; absent retains the personal alias. */
  workspaceId?: string;
  cursor?: string;
  limit: number;
  query?: string;
  readiness?: IntegrationProviderSetupState;
  /** Curated shelf: only these service IDs, in this order. */
  services?: readonly string[];
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
  beforeDispatch?: ConnectorPermissionsHook;
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

/** Trusted permission recheck at the final dispatch boundary. */
export type ConnectorPermissionsHook = () => Promise<void>;

export interface ConnectorCapabilities {
  configured: boolean;
  authTypes: readonly ("oauth2" | "api_key")[];
  actions: boolean;
}

/** A future credential adapter may request fields without returning stored secrets. */
export interface ConnectorConnectForm {
  fields: Array<{ name: string; label: string; secret: boolean }>;
}

export type FetchImpl = typeof fetch;
