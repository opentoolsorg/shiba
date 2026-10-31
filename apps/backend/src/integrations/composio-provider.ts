import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderHealth,
} from "@shiba/shared";
import type { Env } from "../env.js";
import type {
  FetchImpl,
  IntegrationCatalogPage,
  IntegrationCatalogQuery,
  IntegrationConnectContext,
  IntegrationProvider,
} from "./contracts.js";
import { staticCatalogHasMore, staticCatalogPage } from "./static-catalog.js";

const COMPOSIO_API_BASE_URL = "https://backend.composio.dev/api/v3";

type ComposioToolkitRecord = {
  slug?: string;
  name?: string;
  description?: string;
  logo?: string;
  logoUrl?: string;
  meta?: { description?: string; logo?: string };
};

type ComposioConnectedAccountRecord = {
  id?: string;
  appName?: string;
  status?: string;
  toolkit?: { slug?: string };
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function displayName(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapToolkit(record: ComposioToolkitRecord): IntegrationProviderCatalogItem {
  const slug = normalizeSlug(firstString(record.slug, record.name) ?? "");
  return {
    id: slug,
    providerKey: slug,
    name: firstString(record.name) ?? displayName(slug),
    description: firstString(record.description, record.meta?.description) ?? "",
    logoUrl: firstString(record.logoUrl, record.logo, record.meta?.logo),
    isConnected: false,
    connectionId: null,
    source: "composio",
    connectable: true,
  };
}

export interface ComposioIntegrationProviderOptions {
  env: Env;
  fetchImpl?: FetchImpl;
}

export class ComposioIntegrationProvider implements IntegrationProvider {
  readonly id = "composio" as const;
  private readonly env: Env;
  private readonly fetchImpl: FetchImpl;

  constructor(options: ComposioIntegrationProviderOptions) {
    this.env = options.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private apiKey(): string | null {
    const key = this.env.COMPOSIO_API_KEY?.trim();
    return key ? key : null;
  }

  async health(): Promise<IntegrationProviderHealth> {
    const checkedAt = Date.now();
    const apiKey = this.apiKey();
    if (!apiKey) {
      return {
        provider: this.id,
        status: "unconfigured",
        checkedAt,
        message: "Set COMPOSIO_API_KEY (wrangler secret put COMPOSIO_API_KEY) to enable Composio connectors.",
      };
    }
    const response = await this.fetchImpl(`${COMPOSIO_API_BASE_URL}/toolkits?limit=1`, {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    }).catch(() => null);
    if (!response) {
      return {
        provider: this.id,
        status: "unavailable",
        checkedAt,
        message: "Could not reach Composio.",
      };
    }
    return {
      provider: this.id,
      status: response.ok ? "healthy" : "degraded",
      checkedAt,
      ...(response.ok ? {} : { message: `Composio API returned HTTP ${response.status}.` }),
    };
  }

  private async connectedAccounts(userId: string): Promise<ComposioConnectedAccountRecord[]> {
    const apiKey = this.apiKey();
    if (!apiKey) return [];
    const url = new URL(`${COMPOSIO_API_BASE_URL}/connected_accounts`);
    url.searchParams.set("user_ids", userId);
    url.searchParams.set("limit", "100");
    const response = await this.fetchImpl(url, {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { items?: ComposioConnectedAccountRecord[] };
    return Array.isArray(data.items) ? data.items : [];
  }

  async listConnections(args: { userId: string }): Promise<IntegrationProviderConnection[]> {
    const rows = await this.connectedAccounts(args.userId);
    return rows.flatMap((row) => {
      const providerKey = normalizeSlug(firstString(row.toolkit?.slug, row.appName) ?? "");
      if (!providerKey || !row.id || (row.status && row.status !== "ACTIVE")) return [];
      return [
        {
          id: row.id,
          provider: this.id,
          providerKey,
          identityLabel: row.appName ?? null,
        },
      ];
    });
  }

  async listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage> {
    const apiKey = this.apiKey();
    if (!apiKey) {
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

    const connections = await this.listConnections({ userId: query.userId });
    const connected = new Map(connections.map((item) => [item.providerKey, item]));

    const url = new URL(`${COMPOSIO_API_BASE_URL}/toolkits`);
    if (query.query) url.searchParams.set("search", query.query);
    if (query.cursor) url.searchParams.set("cursor", query.cursor);
    url.searchParams.set("limit", String(query.limit));

    const response = await this.fetchImpl(url, {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });

    if (!response.ok) {
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

    const data = (await response.json()) as
      | {
          items?: ComposioToolkitRecord[];
          nextCursor?: string;
          next_cursor?: string;
        }
      | ComposioToolkitRecord[];

    const rows = Array.isArray(data) ? data : (data.items ?? []);
    const normalizedQuery = query.query?.trim().toLowerCase();
    const items = rows
      .map((row) => {
        const item = mapToolkit(row);
        const connection = connected.get(item.providerKey);
        return {
          ...item,
          isConnected: Boolean(connection),
          connectionId: connection?.id ?? null,
        };
      })
      .filter(
        (item) =>
          item.providerKey &&
          (!normalizedQuery ||
            `${item.providerKey} ${item.name} ${item.description}`.toLowerCase().includes(normalizedQuery)),
      );

    const nextCursor = Array.isArray(data)
      ? null
      : firstString(
          !Array.isArray(data) ? data.nextCursor : null,
          !Array.isArray(data) ? data.next_cursor : null,
        );
    return {
      items,
      nextCursor,
      hasMore: nextCursor !== null,
    };
  }

  private callbackUrl(origin: string): string {
    const configured = this.env.INTEGRATIONS_CALLBACK_URI?.trim();
    if (configured) return configured;
    return `${origin.replace(/\/$/, "")}/api/integrations/provider/callback`;
  }

  async beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      return {
        ok: false,
        provider: this.id,
        error: "Composio is not configured. Add COMPOSIO_API_KEY before connecting SaaS integrations.",
      };
    }

    const toolkit = normalizeSlug(context.providerKey);
    const callbackUrl = this.callbackUrl(context.callbackOrigin);

    const authListUrl = new URL(`${COMPOSIO_API_BASE_URL}/auth_configs`);
    authListUrl.searchParams.set("toolkit_slug", toolkit);
    const authListResponse = await this.fetchImpl(authListUrl, {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });

    let authConfigId: string | null = null;
    if (authListResponse.ok) {
      const authList = (await authListResponse.json()) as { items?: Array<{ id?: string }> } | Array<{ id?: string }>;
      const rows = Array.isArray(authList) ? authList : (authList.items ?? []);
      authConfigId = firstString(rows[0]?.id);
    }

    if (!authConfigId) {
      const createResponse = await this.fetchImpl(`${COMPOSIO_API_BASE_URL}/auth_configs`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          toolkit_slug: toolkit,
          auth_scheme: "OAUTH2",
          use_composio_managed_auth: true,
        }),
      });
      if (!createResponse.ok) {
        return {
          ok: false,
          provider: this.id,
          error: `Could not create Composio auth config (HTTP ${createResponse.status}).`,
        };
      }
      const created = (await createResponse.json()) as { id?: string };
      authConfigId = firstString(created.id);
    }

    if (!authConfigId) {
      return { ok: false, provider: this.id, error: "Composio auth config id missing." };
    }

    const linkResponse = await this.fetchImpl(`${COMPOSIO_API_BASE_URL}/connected_accounts/link`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: context.userId,
        callback_url: callbackUrl,
      }),
    });

    if (!linkResponse.ok) {
      return {
        ok: false,
        provider: this.id,
        error: `Composio connect link failed (HTTP ${linkResponse.status}).`,
      };
    }

    const linkBody = (await linkResponse.json()) as {
      redirect_url?: string;
      redirectUrl?: string;
      id?: string;
    };

    return {
      ok: true,
      provider: this.id,
      redirectUrl: firstString(linkBody.redirectUrl, linkBody.redirect_url),
      connectionId: firstString(linkBody.id),
    };
  }

  async disconnect(context: IntegrationConnectContext): Promise<void> {
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error("Composio is not configured.");
    const providerKey = normalizeSlug(context.providerKey);
    const rows = await this.connectedAccounts(context.userId);
    const targets = rows.filter(
      (row) => normalizeSlug(firstString(row.toolkit?.slug, row.appName) ?? "") === providerKey && row.id,
    );
    await Promise.all(
      targets.map((row) =>
        this.fetchImpl(`${COMPOSIO_API_BASE_URL}/connected_accounts/${encodeURIComponent(row.id!)}`, {
          method: "DELETE",
          headers: { "x-api-key": apiKey },
        }),
      ),
    );
  }
}
