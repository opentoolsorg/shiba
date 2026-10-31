import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderConnection,
  IntegrationProviderHealth,
} from "@shiba/shared";
import type { IntegrationCatalogPage, IntegrationCatalogQuery, IntegrationConnectContext, IntegrationProvider } from "./contracts.js";
import { staticCatalogHasMore, staticCatalogPage } from "./static-catalog.js";

export class GrokbotBridgeIntegrationProvider implements IntegrationProvider {
  readonly id = "grokbot" as const;

  async health(): Promise<IntegrationProviderHealth> {
    return {
      provider: this.id,
      status: "healthy",
      checkedAt: Date.now(),
      message: "Grok Bot bridge catalog rows are informational until bridge runtime connects in Grok Bot.",
    };
  }

  async listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage> {
    const items = staticCatalogPage({
      query: query.query,
      cursor: query.cursor,
      limit: query.limit,
      filter: (entry) => entry.kind === "grokbot-bridge",
      source: "grokbot",
      connectable: false,
    });
    const paging = staticCatalogHasMore({
      query: query.query,
      cursor: query.cursor,
      limit: query.limit,
      filter: (entry) => entry.kind === "grokbot-bridge",
    });
    return { items, ...paging, fallbackCatalog: true };
  }

  async listConnections(): Promise<IntegrationProviderConnection[]> {
    return [];
  }

  async beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse> {
    return {
      ok: false,
      provider: this.id,
      error: `Connect ${context.providerKey} through Grok Bot marketplace tools — Shiba bridge runtime wires OAuth separately (PR C).`,
    };
  }

  async disconnect(): Promise<void> {
    throw new Error("Grok Bot bridge connections are managed in Grok Bot, not Shiba disconnect API.");
  }
}
