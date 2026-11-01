import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
} from "@shiba/shared";
import { z } from "zod";
import type { Env } from "../env.js";
import type {
  FetchImpl,
  IntegrationActionQuery,
  IntegrationAction,
  IntegrationCatalogPage,
  IntegrationCatalogQuery,
  IntegrationConnectContext,
  IntegrationExecuteContext,
  IntegrationProvider,
} from "./contracts.js";

const providersSchema = z.array(z.object({
  service: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  iconUrl: z.string().url().optional(),
  authTypes: z.array(z.string()),
}));
const connectionsSchema = z.array(z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  connectionName: z.string(),
  configured: z.boolean(),
  status: z.string().optional(),
  virtual: z.boolean(),
  profile: z.object({ displayName: z.string() }),
}));
const authorizationSchema = z.object({ authorizationUrl: z.string().url() });
const executionSchema = z.object({ success: z.boolean(), data: z.unknown() });

export class OpenConnectorIntegrationProviderError extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
    this.name = "OpenConnectorIntegrationProviderError";
  }
}

/** Upstream aliases are per provider. Derive them only from authenticated Shiba identity. */
export async function openConnectorConnectionName(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return `u_${Array.from(new Uint8Array(digest)).slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class OpenConnectorIntegrationProvider implements IntegrationProvider {
  readonly id = "openconnector" as const;
  private readonly env: Env;
  private readonly fetchImpl: FetchImpl;

  constructor(options: { env: Env; fetchImpl?: FetchImpl }) {
    this.env = options.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private base(): string {
    if (this.env.OPEN_CONNECTOR) return "https://open-connector.internal";
    const configured = this.env.OPEN_CONNECTOR_URL?.trim();
    if (!configured) throw new OpenConnectorIntegrationProviderError("Set OPEN_CONNECTOR or OPEN_CONNECTOR_URL to enable OpenConnector.");
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new OpenConnectorIntegrationProviderError("OPEN_CONNECTOR_URL is invalid.");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
      throw new OpenConnectorIntegrationProviderError("OPEN_CONNECTOR_URL must be an HTTPS URL without credentials, query or fragment (HTTP is allowed on loopback).");
    }
    return url.href.replace(/\/$/, "");
  }

  private async request(path: string, auth: "admin" | "runtime" | null, init: RequestInit = {}): Promise<unknown> {
    const base = this.base();
    const token = auth === "admin" ? this.env.OPEN_CONNECTOR_ADMIN_TOKEN?.trim() : auth === "runtime" ? this.env.OPEN_CONNECTOR_RUNTIME_TOKEN?.trim() : undefined;
    if (auth && !token) throw new OpenConnectorIntegrationProviderError(`Set OPEN_CONNECTOR_${auth.toUpperCase()}_TOKEN to enable OpenConnector ${auth} requests.`);
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      const fetcher = this.env.OPEN_CONNECTOR ? this.env.OPEN_CONNECTOR.fetch.bind(this.env.OPEN_CONNECTOR) : this.fetchImpl;
      response = await fetcher(`${base}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new OpenConnectorIntegrationProviderError("Could not reach OpenConnector.");
    }
    // Never include upstream error bodies: they may contain credentials or tool output.
    if (!response.ok) throw new OpenConnectorIntegrationProviderError(`OpenConnector request failed (HTTP ${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new OpenConnectorIntegrationProviderError("OpenConnector returned an invalid response.");
    }
  }

  private parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new OpenConnectorIntegrationProviderError("OpenConnector returned an invalid response.");
    return parsed.data;
  }

  async health(): Promise<IntegrationProviderHealth> {
    const checkedAt = Date.now();
    try {
      this.base();
      if (!this.env.OPEN_CONNECTOR_ADMIN_TOKEN?.trim() || !this.env.OPEN_CONNECTOR_RUNTIME_TOKEN?.trim()) {
        return { provider: this.id, status: "unconfigured", checkedAt, message: "Set OPEN_CONNECTOR_ADMIN_TOKEN and OPEN_CONNECTOR_RUNTIME_TOKEN." };
      }
    } catch {
      return { provider: this.id, status: "unconfigured", checkedAt, message: "Set OPEN_CONNECTOR or a valid OPEN_CONNECTOR_URL." };
    }
    try {
      this.parse(z.object({ ok: z.literal(true) }), await this.request("/health", null));
      return { provider: this.id, status: "healthy", checkedAt };
    } catch {
      return { provider: this.id, status: "unavailable", checkedAt, message: "OpenConnector health check failed." };
    }
  }

  async listConnections(args: { userId: string }): Promise<IntegrationProviderConnection[]> {
    const connectionName = await openConnectorConnectionName(args.userId);
    const rows = this.parse(connectionsSchema, await this.request("/api/connections", "admin"));
    return rows.filter((row) => row.connectionName === connectionName && row.configured && !row.virtual && row.status !== "reauth_required").map((row) => ({
      id: row.id,
      provider: this.id,
      providerKey: row.service,
      identityLabel: row.profile.displayName,
    }));
  }

  async listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage> {
    const providers = this.parse(providersSchema, await this.request("/api/providers", "admin"));
    const connected = new Map((await this.listConnections({ userId: query.userId })).map((row) => [row.providerKey, row]));
    const search = query.query?.trim().toLowerCase() ?? "";
    const rows = providers.filter((row) => `${row.service} ${row.displayName} ${row.description ?? ""}`.toLowerCase().includes(search));
    const offset = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit) || 8));
    const next = offset + limit;
    return {
      items: rows.slice(offset, next).map((row) => ({
        id: row.service,
        providerKey: row.service,
        name: row.displayName,
        description: row.description ?? "",
        logoUrl: row.iconUrl ?? null,
        source: this.id,
        connectable: row.authTypes.includes("oauth2"),
        isConnected: connected.has(row.service),
        connectionId: connected.get(row.service)?.id ?? null,
      })),
      nextCursor: next < rows.length ? String(next) : null,
      hasMore: next < rows.length,
      fallbackCatalog: false,
    };
  }

  async beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse> {
    try {
      // The /v1 creation endpoint generates a random alias; the local OAuth API accepts ours.
      const result = this.parse(authorizationSchema, await this.request("/api/oauth/authorizations", "admin", {
        method: "POST",
        body: JSON.stringify({ service: context.providerKey, connectionName: await openConnectorConnectionName(context.userId) }),
      }));
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new OpenConnectorIntegrationProviderError("OpenConnector returned an invalid authorization URL.");
      return { ok: true, provider: this.id, redirectUrl: url.href };
    } catch (error) {
      return { ok: false, provider: this.id, error: error instanceof OpenConnectorIntegrationProviderError ? error.message : "OpenConnector connection failed." };
    }
  }

  async disconnect(context: IntegrationConnectContext): Promise<void> {
    await this.request(`/api/connections/${encodeURIComponent(context.providerKey)}`, "admin", {
      method: "DELETE",
      body: JSON.stringify({ connectionName: await openConnectorConnectionName(context.userId) }),
    });
  }

  async searchActions(query: IntegrationActionQuery): Promise<IntegrationAction[]> {
    const params = new URLSearchParams({ q: query.actionId ?? query.query ?? "", service: query.toolkitSlug, limit: String(Math.max(1, Math.min(50, query.limit))) });
    const actionSchema = z.object({
      id: z.string().min(1), service: z.string().min(1), name: z.string(), description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    });
    const actions = query.actionId
      ? [this.parse(z.object({ success: z.literal(true), data: actionSchema }), await this.request(`/v1/actions/${encodeURIComponent(query.actionId)}`, "runtime")).data]
      : this.parse(z.object({ success: z.literal(true), data: z.array(actionSchema) }), await this.request(`/v1/actions/search?${params}`, "runtime")).data;
    return actions.filter((action) => action.service === query.toolkitSlug && (!query.actionId || action.id === query.actionId));
  }

  async executeTool(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse> {
    try {
      // Ignore caller-supplied account/session selectors; only the server-derived alias is trusted.
      const result = this.parse(executionSchema, await this.request(`/v1/actions/${encodeURIComponent(context.toolSlug)}`, "runtime", {
        method: "POST",
        headers: { "x-oo-connector-alias": await openConnectorConnectionName(context.userId) },
        body: JSON.stringify({ input: context.arguments }),
      }));
      if (!result.success) return { ok: false, status: "failed", error: "OpenConnector action failed." };
      return { ok: true, status: "completed", output: result.data };
    } catch (error) {
      return { ok: false, status: "failed", error: error instanceof OpenConnectorIntegrationProviderError ? error.message : "OpenConnector action failed." };
    }
  }
}
