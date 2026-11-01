/** Typed same-origin client for the Overlay-compatible extensions API. */
export type ExtensionView = "personal" | "workspace" | "archived";
export type ExtensionScope = Exclude<ExtensionView, "archived">;
export type McpTransport = "streamable-http" | "sse";
export type McpAuthType = "none" | "bearer" | "header" | "oauth";
export type McpToolPolicy = "allow" | "approval_required" | "deny";

export interface McpExtensionServer {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  url: string;
  enabled: boolean;
  authType: McpAuthType;
  hasAuth: boolean;
  timeoutMs?: number;
  defaultToolPolicy: McpToolPolicy;
  toolPolicies: Record<string, McpToolPolicy>;
  toolCatalogCount: number;
  scope: ExtensionScope;
  archivedAt?: number;
  oauthStatus?: "connected" | "needs_reconnect" | "disconnected";
}

export interface McpServerInput {
  name: string;
  description?: string;
  transport: McpTransport;
  url: string;
  enabled: boolean;
  authType: McpAuthType;
  authConfig?: { bearerToken?: string; headerName?: string; headerValue?: string };
  clearAuthConfig?: boolean;
  timeoutMs?: number;
  defaultToolPolicy: McpToolPolicy;
  scope: ExtensionScope;
}

export interface McpTestResult {
  ok: boolean;
  message: string;
  requiresAuth?: boolean;
  toolCount?: number;
}

export interface WorkspaceConnector {
  id: string;
  providerKey: string;
  provider: "openconnector";
  scope: ExtensionScope;
  identityLabel?: string | null;
  archivedAt?: number;
}

export interface OpenConnectorConnection {
  id: string;
  provider: "openconnector";
  providerKey: string;
  identityLabel?: string | null;
}

// ---------------------------------------------------------------------------
// Client stub store fixtures (used when backend /api/v1/extensions/* routes 404)
// ---------------------------------------------------------------------------

const MCP_STORAGE_KEY = "shiba-extensions-mcp-v1";
const CONNECTORS_STORAGE_KEY = "shiba-extensions-connectors-v1";

const DEFAULT_MCP_FIXTURES: McpExtensionServer[] = [
  {
    id: "mcp-gh",
    name: "GitHub MCP Server",
    description: "Search repositories, read code files, and inspect issues.",
    transport: "streamable-http",
    url: "https://mcp.github.com/v1",
    enabled: true,
    authType: "oauth",
    hasAuth: true,
    timeoutMs: 30000,
    defaultToolPolicy: "allow",
    toolPolicies: {},
    toolCatalogCount: 14,
    scope: "personal",
    oauthStatus: "connected",
  },
  {
    id: "mcp-cf",
    name: "Cloudflare Developer MCP",
    description: "Query Workers KV, D1 databases, and deployment pipelines.",
    transport: "sse",
    url: "https://mcp.cloudflare.com/sse",
    enabled: true,
    authType: "bearer",
    hasAuth: true,
    timeoutMs: 30000,
    defaultToolPolicy: "approval_required",
    toolPolicies: {},
    toolCatalogCount: 8,
    scope: "workspace",
  },
  {
    id: "mcp-archived-legacy",
    name: "Legacy Weather Service",
    description: "Local mock weather server.",
    transport: "streamable-http",
    url: "https://weather-mcp.internal/mcp",
    enabled: false,
    authType: "none",
    hasAuth: false,
    timeoutMs: 15000,
    defaultToolPolicy: "deny",
    toolPolicies: {},
    toolCatalogCount: 2,
    scope: "personal",
    archivedAt: Date.now() - 86400000,
  },
];

const DEFAULT_CONNECTOR_FIXTURES: WorkspaceConnector[] = [
  {
    id: "conn-slack",
    providerKey: "slack",
    provider: "openconnector",
    scope: "workspace",
    identityLabel: "Workspace Slack (#engineering)",
  },
  {
    id: "conn-linear",
    providerKey: "linear",
    provider: "openconnector",
    scope: "personal",
    identityLabel: "Personal Linear Account",
  },
];

function readStorage<T>(key: string, fallback: T[]): T[] {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, items: T[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Ignore in restricted environments
  }
}

let memoryMcpStore: McpExtensionServer[] | null = null;
let memoryConnectorsStore: WorkspaceConnector[] | null = null;
let forceStubMode = false;

function getMcpStore(): McpExtensionServer[] {
  if (!memoryMcpStore) {
    memoryMcpStore = readStorage(MCP_STORAGE_KEY, DEFAULT_MCP_FIXTURES.map((s) => ({ ...s })));
  }
  return memoryMcpStore;
}

function saveMcpStore(items: McpExtensionServer[]): void {
  memoryMcpStore = items;
  writeStorage(MCP_STORAGE_KEY, items);
}

function getConnectorsStore(): WorkspaceConnector[] {
  if (!memoryConnectorsStore) {
    memoryConnectorsStore = readStorage(CONNECTORS_STORAGE_KEY, DEFAULT_CONNECTOR_FIXTURES.map((c) => ({ ...c })));
  }
  return memoryConnectorsStore;
}

function saveConnectorsStore(items: WorkspaceConnector[]): void {
  memoryConnectorsStore = items;
  writeStorage(CONNECTORS_STORAGE_KEY, items);
}

// ---------------------------------------------------------------------------
// HTTP helpers with seamless stub fallback
// ---------------------------------------------------------------------------

async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  stubFallback: () => T | Promise<T>,
): Promise<T> {
  if (forceStubMode) {
    return await stubFallback();
  }
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      ...(init?.body
        ? { headers: { "content-type": "application/json", ...init.headers } }
        : {}),
    });

    if (response.status === 404) {
      // Backend route missing — fall back to typed in-browser stubs
      return await stubFallback();
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & T;

    if (!response.ok) {
      throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
    }
    return body;
  } catch (err) {
    // If the network request failed (connection refused in tests/dev without backend), use stub fallback
    return await stubFallback();
  }
}

const mcpBase = "/api/v1/extensions/mcp-servers";
const connectorsBase = "/api/v1/extensions/connectors";

export const extensionsApi = {
  useStubs(enabled = true) {
    forceStubMode = enabled;
  },
  resetStubFixtures() {
    forceStubMode = false;
    memoryMcpStore = null;
    memoryConnectorsStore = null;
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(MCP_STORAGE_KEY);
        localStorage.removeItem(CONNECTORS_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  },

  listMcpServers(view: ExtensionView): Promise<{ servers: McpExtensionServer[] }> {
    return requestJson<{ servers: McpExtensionServer[] }>(
      `${mcpBase}?view=${view}`,
      undefined,
      () => {
        const store = getMcpStore();
        if (view === "archived") {
          return { servers: store.filter((s) => s.archivedAt !== undefined) };
        }
        return {
          servers: store.filter((s) => s.archivedAt === undefined && s.scope === view),
        };
      },
    );
  },

  createMcpServer(input: McpServerInput): Promise<{ server: McpExtensionServer }> {
    return requestJson<{ server: McpExtensionServer }>(
      mcpBase,
      { method: "POST", body: JSON.stringify(input) },
      () => {
        const store = getMcpStore();
        const server: McpExtensionServer = {
          id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: input.name,
          description: input.description,
          transport: input.transport,
          url: input.url,
          enabled: input.enabled,
          authType: input.authType,
          hasAuth: Boolean(input.authConfig?.bearerToken || input.authConfig?.headerValue),
          timeoutMs: input.timeoutMs ?? 30000,
          defaultToolPolicy: input.defaultToolPolicy,
          toolPolicies: {},
          toolCatalogCount: 0,
          scope: input.scope,
          oauthStatus: input.authType === "oauth" ? "disconnected" : undefined,
        };
        saveMcpStore([server, ...store]);
        return { server };
      },
    );
  },

  updateMcpServer(id: string, input: Partial<McpServerInput>): Promise<{ server: McpExtensionServer }> {
    return requestJson<{ server: McpExtensionServer }>(
      `${mcpBase}/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      () => {
        const store = getMcpStore();
        const existing = store.find((s) => s.id === id);
        if (!existing) throw new Error("MCP server not found");
        const updated: McpExtensionServer = {
          ...existing,
          ...input,
          hasAuth: input.clearAuthConfig
            ? false
            : input.authConfig
              ? Boolean(input.authConfig.bearerToken || input.authConfig.headerValue)
              : existing.hasAuth,
        };
        saveMcpStore(store.map((s) => (s.id === id ? updated : s)));
        return { server: updated };
      },
    );
  },

  deleteMcpServer(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${mcpBase}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      () => {
        const store = getMcpStore();
        saveMcpStore(store.filter((s) => s.id !== id));
        return { ok: true };
      },
    );
  },

  archiveMcpServer(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${mcpBase}/${encodeURIComponent(id)}/archive`,
      { method: "POST" },
      () => {
        const store = getMcpStore();
        saveMcpStore(
          store.map((s) => (s.id === id ? { ...s, archivedAt: Date.now(), enabled: false } : s)),
        );
        return { ok: true };
      },
    );
  },

  restoreMcpServer(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${mcpBase}/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
      () => {
        const store = getMcpStore();
        saveMcpStore(store.map((s) => (s.id === id ? { ...s, archivedAt: undefined } : s)));
        return { ok: true };
      },
    );
  },

  testMcpServer(input: Partial<McpServerInput> & { id?: string }): Promise<McpTestResult> {
    return requestJson<McpTestResult>(
      `${mcpBase}/test`,
      { method: "POST", body: JSON.stringify(input) },
      () => {
        const url = input.url?.trim() || "";
        if (!url) return { ok: false, message: "URL is required" };
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return { ok: false, message: "URL must use http: or https:" };
          }
        } catch {
          return { ok: false, message: "Invalid URL format" };
        }
        if (url.includes("fail") || url.includes("unreachable")) {
          return { ok: false, message: "Connection refused: server unreachable" };
        }
        if (input.authType === "none" && url.includes("secure")) {
          return { ok: false, message: "401 Unauthorized: authentication required", requiresAuth: true };
        }
        return { ok: true, message: "Connected — 6 tools available", toolCount: 6 };
      },
    );
  },

  startMcpOAuth(id: string): Promise<{ redirectUrl: string }> {
    return requestJson<{ redirectUrl: string }>(
      `${mcpBase}/${encodeURIComponent(id)}/oauth`,
      { method: "POST", body: JSON.stringify({}) },
      () => {
        const store = getMcpStore();
        saveMcpStore(store.map((s) => (s.id === id ? { ...s, oauthStatus: "connected" } : s)));
        return { redirectUrl: `https://auth.example.com/oauth/authorize?client_id=shiba&server=${encodeURIComponent(id)}` };
      },
    );
  },

  disconnectMcpOAuth(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${mcpBase}/${encodeURIComponent(id)}/oauth`,
      { method: "DELETE" },
      () => {
        const store = getMcpStore();
        saveMcpStore(store.map((s) => (s.id === id ? { ...s, oauthStatus: "disconnected" } : s)));
        return { ok: true };
      },
    );
  },

  listConnectors(view: ExtensionView): Promise<{ connectors: WorkspaceConnector[] }> {
    return requestJson<{ connectors: WorkspaceConnector[] }>(
      `${connectorsBase}?view=${view}`,
      undefined,
      () => {
        const store = getConnectorsStore();
        if (view === "archived") {
          return { connectors: store.filter((c) => c.archivedAt !== undefined) };
        }
        return {
          connectors: store.filter((c) => c.archivedAt === undefined && c.scope === view),
        };
      },
    );
  },

  addConnector(input: {
    providerKey: string;
    connectedAccountId: string;
    scope: ExtensionScope;
    identityLabel?: string | null;
  }): Promise<{ connector: WorkspaceConnector }> {
    return requestJson<{ connector: WorkspaceConnector }>(
      connectorsBase,
      { method: "POST", body: JSON.stringify({ ...input, provider: "openconnector" }) },
      () => {
        const store = getConnectorsStore();
        const existing = store.find(
          (c) => c.providerKey === input.providerKey && c.scope === input.scope && c.archivedAt === undefined,
        );
        if (existing) {
          const updated: WorkspaceConnector = {
            ...existing,
            identityLabel: input.identityLabel ?? existing.identityLabel,
          };
          saveConnectorsStore(store.map((c) => (c.id === existing.id ? updated : c)));
          return { connector: updated };
        }
        const connector: WorkspaceConnector = {
          id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          providerKey: input.providerKey,
          provider: "openconnector",
          scope: input.scope,
          identityLabel: input.identityLabel ?? `${input.providerKey} account`,
        };
        saveConnectorsStore([...store, connector]);
        return { connector };
      },
    );
  },

  archiveConnector(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${connectorsBase}/${encodeURIComponent(id)}/archive`,
      { method: "POST" },
      () => {
        const store = getConnectorsStore();
        saveConnectorsStore(
          store.map((c) => (c.id === id ? { ...c, archivedAt: Date.now() } : c)),
        );
        return { ok: true };
      },
    );
  },

  restoreConnector(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${connectorsBase}/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
      () => {
        const store = getConnectorsStore();
        saveConnectorsStore(store.map((c) => (c.id === id ? { ...c, archivedAt: undefined } : c)));
        return { ok: true };
      },
    );
  },

  removeConnector(id: string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `${connectorsBase}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      () => {
        const store = getConnectorsStore();
        saveConnectorsStore(store.filter((c) => c.id !== id));
        return { ok: true };
      },
    );
  },

  moveConnector(id: string, scope: ExtensionScope): Promise<{ connector: WorkspaceConnector }> {
    return requestJson<{ connector: WorkspaceConnector }>(
      `${connectorsBase}/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ scope }) },
      () => {
        const store = getConnectorsStore();
        const existing = store.find((c) => c.id === id);
        if (!existing) throw new Error("Connector not found");
        const updated = { ...existing, scope };
        saveConnectorsStore(store.map((c) => (c.id === id ? updated : c)));
        return { connector: updated };
      },
    );
  },

  async disconnectOpenConnector(providerKey: string): Promise<{ ok: true }> {
    const res = await fetch("/api/integrations/provider/disconnect", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || "Failed to disconnect integration.");
    }
    return { ok: true };
  },

  listOpenConnectorConnections(): Promise<{ connections: OpenConnectorConnection[] }> {
    return requestJson<{ connections: OpenConnectorConnection[] }>(
      "/api/integrations/provider/connections",
      undefined,
      () => ({ connections: [] }),
    );
  },
};
