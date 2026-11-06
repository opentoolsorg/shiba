import type {
  IntegrationProviderBeginConnectResponse,
  IntegrationProviderConnection,
  IntegrationProviderExecuteResponse,
  IntegrationProviderHealth,
  IntegrationProviderSetupState,
} from "@shiba/shared";
import { z } from "zod";
import { isTeamWorkspaceId, integrationActionOperationTypeSchema } from "@shiba/shared";
import type { Env } from "../env.js";
import { assertActionArgumentsAllowed, assertActionInputAllowed, IntegrationActionInputPolicyError, requiresProtectedActionInput } from "./action-input-policy.js";
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
  oauthAuthorizationId: z.string().min(1).optional(),
  virtual: z.boolean(),
  profile: z.object({ displayName: z.string() }),
}));
const authorizationSchema = z.object({ authorizationUrl: z.string().url(), state: z.string().min(1) });
const executionSchema = z.object({ success: z.boolean(), data: z.unknown() });
const setupSchema = z.object({ success: z.literal(true), data: z.object({ service: z.string(), oauthClient: z.object({ configured: z.boolean(), missingFields: z.array(z.string()) }).optional() }) });
const SERVICE = /^[A-Za-z0-9_-]{1,100}$/;
const CATALOG_PROBE_BUDGET = 40;

async function fingerprint(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

/** Sharing requires a separate server-derived namespace, never a personal account alias. */
export async function openConnectorWorkspaceConnectionName(workspaceId: string): Promise<string> {
  if (!isTeamWorkspaceId(workspaceId)) throw new OpenConnectorIntegrationProviderError("Workspace scope is invalid.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["shiba:workspace-app:v1", workspaceId])));
  return `w_${Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function scopedConnectionName(userId: string, workspaceId?: string) {
  return workspaceId === undefined ? openConnectorConnectionName(userId) : openConnectorWorkspaceConnectionName(workspaceId);
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

  private async request(path: string, auth: "admin" | "runtime" | null, init: RequestInit = {}, beforeFetch?: () => void): Promise<unknown> {
    const base = this.base();
    const token = auth === "admin" ? this.env.OPEN_CONNECTOR_ADMIN_TOKEN?.trim() : auth === "runtime" ? this.env.OPEN_CONNECTOR_RUNTIME_TOKEN?.trim() : undefined;
    if (auth && !token) throw new OpenConnectorIntegrationProviderError(`Set OPEN_CONNECTOR_${auth.toUpperCase()}_TOKEN to enable OpenConnector ${auth} requests.`);
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      const fetcher = this.env.OPEN_CONNECTOR ? this.env.OPEN_CONNECTOR.fetch.bind(this.env.OPEN_CONNECTOR) : this.fetchImpl;
      const requestInit: RequestInit = {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
      };
      beforeFetch?.();
      response = await fetcher(`${base}${path}`, requestInit);
    } catch (error) {
      if (error instanceof OpenConnectorIntegrationProviderError) throw error;
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

  /** Classify OAuth setup from authenticated metadata; failures remain unverified, never connectable. */
  private async oauthSetup(service: string): Promise<IntegrationProviderSetupState> {
    if (!SERVICE.test(service)) return "unsupported";
    try {
      // The pinned upstream classifies this metadata path as admin/connection management.
      const setup = this.parse(setupSchema, await this.request(`/v1/providers/${encodeURIComponent(service)}/setup`, "admin")).data;
      if (setup.service !== service) return "unverified";
      if (!setup.oauthClient) return "unsupported";
      return setup.oauthClient.configured && setup.oauthClient.missingFields.length === 0 ? "ready" : "needs_configuration";
    } catch { return "unverified"; }
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
      // Metadata only: this verifies the configured tokens without touching an
      // app account, running an Action, or requiring broader token permissions.
      try {
        await Promise.all([
          this.request("/api/providers", "admin").then((body) => this.parse(providersSchema, body)),
          this.request("/v1/providers?service=__shiba_readiness__", "runtime").then((body) => this.parse(z.object({ success: z.literal(true), data: z.array(z.unknown()) }), body)),
        ]);
      } catch { return { provider: this.id, status: "degraded", checkedAt, message: "Service reachable; admin or runtime metadata authentication is unavailable. App accounts and employee grants are not verified." }; }
      return { provider: this.id, status: "healthy", checkedAt, message: "Service and metadata access succeeded. Upstream authentication enforcement, app consent, live actions and employee grants require separate verification." };
    } catch {
      return { provider: this.id, status: "unavailable", checkedAt, message: "OpenConnector health check failed." };
    }
  }

  private async ownedConnectionRows(userId: string, workspaceId?: string) {
    const connectionName = await scopedConnectionName(userId, workspaceId);
    const rows = this.parse(connectionsSchema, await this.request("/api/connections", "admin"));
    return rows.filter((row) => row.connectionName === connectionName);
  }

  async listConnections(args: { userId: string; includeUnavailable?: boolean; workspaceId?: string }): Promise<IntegrationProviderConnection[]> {
    const rows = (await this.ownedConnectionRows(args.userId, args.workspaceId)).filter((row) => !row.virtual);
    return Promise.all(rows.filter((row) => args.includeUnavailable || (row.configured && Boolean(row.oauthAuthorizationId) && (row.status === undefined || row.status === "active"))).map(async (row) => {
      const active = row.configured && (row.status === undefined || row.status === "active");
      const consent = row.oauthAuthorizationId;
      return {
        id: `ocg_${await fingerprint([row.connectionName, row.service, row.id, consent ?? "unverified"] )}`,
        provider: this.id,
        providerKey: row.service,
        identityLabel: row.profile.displayName,
        ...(consent ? { authorizationFingerprint: await fingerprint([row.connectionName, row.service, consent]) } : {}),
        executionReady: active && Boolean(consent),
        connectionState: active ? "active" : row.status === "reauth_required" ? "reauth_required" : "unavailable",
        ...(!active ? { unavailableReason: "Account authorization is unavailable. Reconnect to restore access; the existing account is preserved until new consent succeeds." }
          : !consent ? { unavailableReason: "This account has no verifiable OAuth consent generation. Employee actions are unavailable; ask the operator for a supported OAuth connection." } : {}),
      } satisfies IntegrationProviderConnection;
    }));
  }

  /** Return a searchable catalog, probing only bounded metadata for readiness-filtered pages. */
  async listCatalog(query: IntegrationCatalogQuery): Promise<IntegrationCatalogPage> {
    const providers = this.parse(providersSchema, await this.request("/api/providers", "admin"));
    const connected = new Map((await this.listConnections({ userId: query.userId, ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}) })).map((row) => [row.providerKey, row]));
    const search = query.query?.trim().toLowerCase() ?? "";
    const matches = providers.filter((row) => `${row.service} ${row.displayName} ${row.description ?? ""}`.toLowerCase().includes(search));
    const oauth = (row: (typeof providers)[number]) => row.authTypes.includes("oauth2");
    const offset = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit) || 8));
    const readiness = query.readiness;
    // Upstream lists every service; only OAuth services need a per-service client probe.
    const rows = readiness === undefined ? matches : readiness === "unsupported" ? matches.filter((row) => !oauth(row)) : matches.filter(oauth);
    const setup = new Map<string, IntegrationProviderSetupState>();
    const page: typeof rows = [];
    let next = offset;
    if (readiness === undefined || readiness === "unsupported") {
      page.push(...rows.slice(offset, offset + limit));
      next = offset + page.length;
      await this.probeSetup(page, setup);
    } else {
      // A filtered page may scan past non-matching services; the probe budget bounds upstream reads per request.
      const budget = Math.max(limit, CATALOG_PROBE_BUDGET);
      while (next < rows.length && page.length < limit && next - offset < budget) {
        const batch = rows.slice(next, Math.min(next + 4, offset + budget, rows.length));
        await this.probeSetup(batch, setup);
        for (const row of batch) {
          next++;
          if (setup.get(row.service) === readiness) page.push(row);
          if (page.length >= limit) break;
        }
      }
    }
    return {
      items: page.map((row) => ({
        id: row.service,
        providerKey: row.service,
        name: row.displayName,
        description: row.description ?? "",
        logoUrl: row.iconUrl ?? null,
        source: this.id,
        connectable: setup.get(row.service) === "ready",
        setupState: setup.get(row.service) ?? "unverified",
        authTypes: row.authTypes,
        isConnected: connected.has(row.service),
        connectionId: connected.get(row.service)?.id ?? null,
      })),
      nextCursor: next < rows.length ? String(next) : null,
      hasMore: next < rows.length,
      fallbackCatalog: false,
      total: matches.length,
      oauthCapable: matches.filter(oauth).length,
    };
  }

  /** Four metadata reads at a time; a failed setup check cannot enable OAuth. */
  private async probeSetup(rows: { service: string; authTypes: string[] }[], into: Map<string, IntegrationProviderSetupState>): Promise<void> {
    for (let start = 0; start < rows.length; start += 4) {
      await Promise.all(rows.slice(start, start + 4).map(async (row) => {
        if (!into.has(row.service)) into.set(row.service, row.authTypes.includes("oauth2") ? await this.oauthSetup(row.service) : "unsupported");
      }));
    }
  }

  async beginConnect(context: IntegrationConnectContext): Promise<IntegrationProviderBeginConnectResponse> {
    try {
      if (!SERVICE.test(context.providerKey)) return { ok: false, provider: this.id, error: "Unsupported provider identifier." };
      const existing = (await this.ownedConnectionRows(context.userId, context.workspaceId)).filter((row) => row.service === context.providerKey && !row.virtual);
      const replaceable = context.replaceUnavailable === true && existing.every((row) => !row.configured || (row.status !== undefined && row.status !== "active"));
      if (existing.length && !replaceable) return { ok: false, provider: this.id, error: context.replaceUnavailable ? "Only an expired or unavailable account can be reconnected. Disconnect the active account explicitly first." : "Disconnect the existing owned account before starting a new connection. Existing consent cannot confirm a new sign-in." };
      const setup = await this.oauthSetup(context.providerKey);
      if (setup !== "ready") return { ok: false, provider: this.id, error: setup === "needs_configuration" ? "Configure this provider's OAuth application in OpenConnector before connecting an account." : setup === "unsupported" ? "This provider has no supported OAuth sign-in path. Configure its credentials with the OpenConnector operator." : "Provider OAuth setup could not be verified. Refresh readiness before connecting." };
      // Keep the existing upstream account intact while consent is pending; OAuth may be rejected or abandoned.
      // The /v1 creation endpoint generates a random alias; the local OAuth API accepts ours.
      const result = this.parse(authorizationSchema, await this.request("/api/oauth/authorizations", "admin", {
        method: "POST",
        body: JSON.stringify({ service: context.providerKey, connectionName: await scopedConnectionName(context.userId, context.workspaceId) }),
      }));
      const url = new URL(result.authorizationUrl);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) throw new OpenConnectorIntegrationProviderError("OpenConnector returned an invalid authorization URL.");
      return { ok: true, provider: this.id, redirectUrl: url.href, authorizationFingerprint: await fingerprint([await scopedConnectionName(context.userId, context.workspaceId), context.providerKey, result.state]) };
    } catch (error) {
      return { ok: false, provider: this.id, error: error instanceof OpenConnectorIntegrationProviderError ? error.message : "OpenConnector connection failed." };
    }
  }

  async disconnect(context: IntegrationConnectContext): Promise<void> {
    await this.request(`/api/connections/${encodeURIComponent(context.providerKey)}`, "admin", {
      method: "DELETE",
      body: JSON.stringify({ connectionName: await scopedConnectionName(context.userId, context.workspaceId) }),
    });
  }

  async searchActions(query: IntegrationActionQuery): Promise<IntegrationAction[]> {
    const params = new URLSearchParams({ q: query.actionId ?? (query.query?.trim() || query.toolkitSlug), service: query.toolkitSlug, limit: String(Math.max(1, Math.min(50, Math.floor(query.limit)))) });
    const headers = { "x-oo-connector-alias": await scopedConnectionName(query.userId, query.workspaceId) };
    const actionSchema = z.object({
      id: z.string().min(1), service: z.string().min(1), name: z.string(), description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      // Metadata is advisory even when the provider calls an action a read.
      operationType: integrationActionOperationTypeSchema.catch("unclassified"),
    });
    const actions = query.actionId
      ? [this.parse(z.object({ success: z.literal(true), data: actionSchema }), await this.request(`/v1/actions/${encodeURIComponent(query.actionId)}`, "runtime", { headers })).data]
      : this.parse(z.object({ success: z.literal(true), data: z.array(actionSchema) }), await this.request(`/v1/actions/search?${params}`, "runtime", { headers })).data;
    const selected = actions.filter((action) => action.service === query.toolkitSlug && (!query.actionId || action.id === query.actionId));
    if (query.actionId) selected.forEach((action) => assertActionInputAllowed(action));
    // Never expose a schema that asks a person or model to paste a developer credential.
    return selected.filter((action) => !requiresProtectedActionInput(action));
  }

  async executeTool(context: IntegrationExecuteContext): Promise<IntegrationProviderExecuteResponse> {
    try {
      const assertSendCurrent = () => {
        context.signal?.throwIfAborted();
        if (context.approvedUntil !== undefined && (!Number.isSafeInteger(context.approvedUntil) || Date.now() >= context.approvedUntil)) {
          throw new OpenConnectorIntegrationProviderError("App action consent expired. Request a new human approval before retrying.");
        }
      };
      assertSendCurrent();
      assertActionArgumentsAllowed(context.toolkitSlug ?? "", context.arguments, context.toolSlug);
      if (!context.toolkitSlug || !context.approvedConnectionId) return { ok: false, status: "failed", error: "A current employee-approved app connection is required." };
      if (context.toolSlug.startsWith("googleads.") && context.toolkitSlug !== "googleads") return { ok: false, status: "failed", error: "The requested action does not belong to the approved integration." };
      if (context.toolkitSlug === "googleads") {
        const actions = await this.searchActions({ userId: context.userId, workspaceId: context.workspaceId, toolkitSlug: context.toolkitSlug, actionId: context.toolSlug, limit: 1 });
        if (actions.length !== 1) return { ok: false, status: "failed", error: "The requested Google Ads action is unavailable." };
        assertActionInputAllowed(actions[0]!, context.arguments);
      }
      const rows = await this.ownedConnectionRows(context.userId, context.workspaceId);
      let selected: (typeof rows)[number] | undefined;
      for (const row of rows) {
        if (row.service !== context.toolkitSlug || !row.configured || row.virtual || (row.status !== undefined && row.status !== "active") || !row.oauthAuthorizationId) continue;
        const id = `ocg_${await fingerprint([row.connectionName, row.service, row.id, row.oauthAuthorizationId])}`;
        if (id === context.approvedConnectionId) selected = row;
      }
      if (!selected) return { ok: false, status: "failed", error: "The approved app consent generation is unavailable or changed. Review the current connection and employee grant again." };
      const alias = await scopedConnectionName(context.userId, context.workspaceId);
      const body = JSON.stringify({ input: context.arguments });
      await context.beforeDispatch?.();
      assertSendCurrent();
      // Ignore caller-supplied account/session selectors; only the server-derived alias is trusted.
      const result = this.parse(executionSchema, await this.request(`/v1/actions/${encodeURIComponent(context.toolSlug)}`, "runtime", {
        method: "POST",
        headers: { "x-oo-connector-alias": alias, "x-oo-connector-app-id": selected.id },
        body,
        ...(context.signal ? { signal: context.signal } : {}),
      }, assertSendCurrent));
      if (!result.success) return { ok: false, status: "failed", error: "OpenConnector action failed." };
      return { ok: true, status: "completed", output: result.data };
    } catch (error) {
      return { ok: false, status: "failed", error: error instanceof OpenConnectorIntegrationProviderError || error instanceof IntegrationActionInputPolicyError ? error.message : "OpenConnector action failed." };
    }
  }
}
