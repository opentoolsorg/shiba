import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderCatalogItem,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
  IntegrationProviderSessionResponse,
} from "@shiba/shared";
import type { Env } from "../env.js";
import type {
  FetchImpl,
  IntegrationCatalogPage,
  IntegrationCatalogQuery,
  IntegrationConnectContext,
  IntegrationExecuteContext,
  IntegrationProvider,
} from "./contracts.js";
import { staticCatalogHasMore, staticCatalogPage } from "./static-catalog.js";
import {
  composioApiKey,
  composioFetchJson,
  composioSessionBase,
  composioV3Base,
  firstString,
  normalizeSlug,
  parseComposioToolkitPage,
} from "./composio-api.js";

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

export class ComposioIntegrationProviderError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "ComposioIntegrationProviderError";
  }
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
    return composioApiKey(this.env);
  }

  private requireApiKey(): string {
    const key = this.apiKey();
    if (!key) {
      throw new ComposioIntegrationProviderError(
        "Composio is not configured. Set COMPOSIO_API_KEY (wrangler secret put COMPOSIO_API_KEY).",
        503,
      );
    }
    return key;
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
    const base = composioV3Base(this.env);
    const response = await this.fetchImpl(`${base}/toolkits?limit=1`, {
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
    const url = new URL(`${composioV3Base(this.env)}/connected_accounts`);
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

    const url = new URL(`${composioV3Base(this.env)}/toolkits`);
    if (query.query?.trim()) url.searchParams.set("search", query.query.trim());
    if (query.cursor) url.searchParams.set("cursor", query.cursor);
    url.searchParams.set("limit", String(query.limit));

    const result = await composioFetchJson(this.fetchImpl, url, apiKey);
    if (!result.ok) {
      throw new ComposioIntegrationProviderError(
        `Composio catalog unavailable (HTTP ${result.status}).`,
        result.status >= 400 && result.status < 500 ? result.status : 503,
      );
    }

    const page = parseComposioToolkitPage(result.data, query.limit);
    const items = page.items
      .map((row) => mapToolkit(row as ComposioToolkitRecord))
      .filter((item) => item.providerKey)
      .map((item) => {
        const connection = connected.get(item.providerKey);
        return {
          ...item,
          isConnected: Boolean(connection),
          connectionId: connection?.id ?? null,
        };
      });

    return {
      items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      fallbackCatalog: false,
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
    const base = composioV3Base(this.env);

    const authListUrl = new URL(`${base}/auth_configs`);
    authListUrl.searchParams.set("toolkit_slug", toolkit);
    const authList = await composioFetchJson(this.fetchImpl, authListUrl, apiKey);

    let authConfigId: string | null = null;
    if (authList.ok) {
      const rows = Array.isArray(authList.data)
        ? authList.data
        : ((authList.data as { items?: Array<{ id?: string }> })?.items ?? []);
      authConfigId = firstString(rows[0]?.id);
    }

    if (!authConfigId) {
      const createResponse = await composioFetchJson(this.fetchImpl, `${base}/auth_configs`, apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      authConfigId = firstString((createResponse.data as { id?: string })?.id);
    }

    if (!authConfigId) {
      return { ok: false, provider: this.id, error: "Composio auth config id missing." };
    }

    const linkResponse = await composioFetchJson(this.fetchImpl, `${base}/connected_accounts/link`, apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

    const linkBody = linkResponse.data as {
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
    const apiKey = this.requireApiKey();
    const providerKey = normalizeSlug(context.providerKey);
    const rows = await this.connectedAccounts(context.userId);
    const targets = rows.filter(
      (row) => normalizeSlug(firstString(row.toolkit?.slug, row.appName) ?? "") === providerKey && row.id,
    );
    await Promise.all(
      targets.map((row) =>
        this.fetchImpl(`${composioV3Base(this.env)}/connected_accounts/${encodeURIComponent(row.id!)}`, {
          method: "DELETE",
          headers: { "x-api-key": apiKey },
        }),
      ),
    );
  }

  inferToolkitSlug(toolSlug: string, explicit?: string): string {
    if (explicit?.trim()) return normalizeSlug(explicit);
    const prefix = toolSlug.split("_")[0];
    return prefix ? normalizeSlug(prefix) : normalizeSlug(toolSlug);
  }

  async createToolRouterSession(args: {
    userId: string;
    toolkitSlugs: string[];
  }): Promise<IntegrationProviderSessionResponse> {
    const apiKey = this.requireApiKey();
    const unique = [...new Set(args.toolkitSlugs.map(normalizeSlug).filter(Boolean))];
    if (unique.length === 0) {
      return { ok: false, error: "At least one toolkit slug is required." };
    }
    const sessionBase = composioSessionBase(this.env);
    const result = await composioFetchJson(this.fetchImpl, `${sessionBase}/tool_router/session`, apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: args.userId,
        toolkits: { enable: unique },
      }),
    });
    if (!result.ok) {
      return { ok: false, error: `Composio session create failed (HTTP ${result.status}).` };
    }
    const sessionId = firstString(
      (result.data as { session_id?: string })?.session_id,
      (result.data as { sessionId?: string })?.sessionId,
      (result.data as { id?: string })?.id,
    );
    if (!sessionId) return { ok: false, error: "Composio session id missing in response." };
    return { ok: true, sessionId };
  }

  async executeTool(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse> {
    const apiKey = this.requireApiKey();
    const toolkitSlug = this.inferToolkitSlug(context.toolSlug, context.toolkitSlug);
    let sessionId = context.sessionId?.trim() ?? null;
    if (!sessionId) {
      const created = await this.createToolRouterSession({
        userId: context.userId,
        toolkitSlugs: [toolkitSlug],
      });
      if (!created.ok || !created.sessionId) {
        return { ok: false, status: "failed", error: created.error ?? "Could not create Composio session." };
      }
      sessionId = created.sessionId;
    }

    const sessionBase = composioSessionBase(this.env);
    const executeBody: Record<string, unknown> = {
      tool_slug: context.toolSlug,
      arguments: context.arguments ?? {},
    };
    if (context.connectedAccountId) executeBody.account = context.connectedAccountId;

    const result = await composioFetchJson(
      this.fetchImpl,
      `${sessionBase}/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
      apiKey,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(executeBody),
      },
    );

    if (!result.ok) {
      return {
        ok: false,
        status: "failed",
        sessionId,
        error: `Composio tool execute failed (HTTP ${result.status}).`,
      };
    }

    return {
      ok: true,
      status: "completed",
      sessionId,
      output: result.data,
    };
  }
}
