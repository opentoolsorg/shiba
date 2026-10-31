import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderConnection,
  IntegrationProviderHealth,
} from "@shiba/shared";
import type { IntegrationCatalogPage, IntegrationCatalogQuery, IntegrationConnectContext, IntegrationProvider } from "./contracts.js";
import { staticCatalogHasMore, staticCatalogPage } from "./static-catalog.js";

export class NoneIntegrationProvider implements IntegrationProvider {
  readonly id = "none" as const;

  async health(): Promise<IntegrationProviderHealth> {
    return {
      provider: this.id,
      status: "healthy",
      checkedAt: Date.now(),
      message: "SaaS connector factory disabled (INTEGRATIONS_PROVIDER=none). Native and MCP paths remain available.",
    };
  }

  async listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage> {
    const items = staticCatalogPage({
      query: query.query,
      cursor: query.cursor,
      limit: query.limit,
      source: "static",
      connectable: false,
    });
    const paging = staticCatalogHasMore({
      query: query.query,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items, ...paging, fallbackCatalog: true };
  }

  async listConnections(): Promise<IntegrationProviderConnection[]> {
    return [];
  }

  async beginConnect(): Promise<IntegrationProviderBeginConnectResponse> {
    return {
      ok: false,
      provider: this.id,
      error: "SaaS integrations provider is disabled. Set INTEGRATIONS_PROVIDER=composio to enable Composio connectors.",
    };
  }

  async disconnect(_context: IntegrationConnectContext): Promise<void> {
    throw new Error("SaaS integrations provider is disabled.");
  }
}
