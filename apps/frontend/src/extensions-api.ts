/** Typed same-origin client for the extensions API. */
import { integrationProviderConnectionsResponseSchema } from "@shiba/shared";
export type ExtensionView = "personal" | "workspace" | "archived";
export type ExtensionScope = Exclude<ExtensionView, "archived">;
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
// Client fixtures, enabled explicitly by tests or local review.
// ---------------------------------------------------------------------------

const CONNECTORS_STORAGE_KEY = "shiba-extensions-connectors-v1";

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

let memoryConnectorsStore: WorkspaceConnector[] | null = null;
let forceStubMode = false;

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
// HTTP helpers; fixture responses require explicit opt-in.
// ---------------------------------------------------------------------------

async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  stubFallback: () => T | Promise<T>,
): Promise<T> {
  if (forceStubMode) {
    return await stubFallback();
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    ...(init?.body
      ? { headers: { "content-type": "application/json", ...init.headers } }
      : {}),
  });
  let body: {
    error?: string;
    message?: string;
  } & T;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? "Invalid extensions API response" : `Request failed (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  }
  return body;
}

const connectorsBase = "/api/v1/extensions/connectors";

export const extensionsApi = {
  useStubs(enabled = true) {
    forceStubMode = enabled;
  },
  resetStubFixtures() {
    forceStubMode = false;
    memoryConnectorsStore = null;
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(CONNECTORS_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  },

  listConnectors(view: ExtensionView): Promise<{ connectors: WorkspaceConnector[] }> {
    if (!forceStubMode) {
      if (view !== "personal") return Promise.reject(new Error("Shared and archived app registries are unavailable. App accounts stay private; configure employee resource grants separately."));
      return extensionsApi.listOpenConnectorConnections().then(({ connections }) => ({ connectors: connections.map((connection) => ({ ...connection, scope: "personal" as const })) }));
    }
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
    if (!forceStubMode) return Promise.reject(new Error("App account linking uses verified OpenConnector consent. Configure employee resource grants separately."));
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
    if (!forceStubMode) return Promise.reject(new Error("Provider accounts cannot be archived here. Use the explicit Disconnect action to revoke a connection."));
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
    if (!forceStubMode) return Promise.reject(new Error("Provider accounts require a new verified sign-in; local restore is unavailable."));
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
    if (!forceStubMode) return Promise.reject(new Error("Use the explicit Disconnect action for the owned OpenConnector account."));
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
    if (!forceStubMode) return Promise.reject(new Error("App credentials cannot be moved between people or workspaces. Configure employee resource grants separately."));
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

  async listOpenConnectorConnections(): Promise<{ connections: OpenConnectorConnection[] }> {
    const body = await requestJson<{ connections: OpenConnectorConnection[] }>(
      "/api/integrations/provider/connections",
      undefined,
      () => ({ connections: [] }),
    );
    if (forceStubMode) return body;
    const parsed = integrationProviderConnectionsResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error("The owned app account response could not be verified.");
    return { connections: parsed.data.connections };
  },
};
