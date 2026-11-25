import type {
  IntegrationProviderBeginConnectResponse, IntegrationProviderConnection,
  IntegrationProviderExecuteResponse, IntegrationProviderHealth, IntegrationsProviderId,
} from "@shiba/shared";
import type {
  ConnectorCapabilities, ConnectorConnectForm, IntegrationAction, IntegrationActionQuery,
  IntegrationCatalogPage, IntegrationCatalogQuery, IntegrationConnectContext, IntegrationExecuteContext,
} from "./types.js";

export interface ConnectorProvider {
  /** Legacy wire identity; adapterId identifies the selected implementation. */
  readonly id: IntegrationsProviderId;
  readonly adapterId: "openconnector" | "none";
  readonly capabilities: ConnectorCapabilities;
  health(): Promise<IntegrationProviderHealth>;
  listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage>;
  searchActions(query: IntegrationActionQuery): Promise<IntegrationAction[]>;
  listConnections(args: { userId: string; includeUnavailable?: boolean; workspaceId?: string }): Promise<IntegrationProviderConnection[]>;
  beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse & { form?: ConnectorConnectForm }>;
  disconnect(context: IntegrationConnectContext): Promise<void>;
  executeTool(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse>;
}

export type IntegrationProvider = ConnectorProvider;
