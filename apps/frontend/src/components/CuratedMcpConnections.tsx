import { IntegrationLogo } from "./IntegrationLogo";
import { CURATED_MCP_VENDORS, type CuratedMcpVendor } from "@shiba/shared";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { RoleCapabilityFilter } from "./RoleCapabilityFilter";
import { roleCapabilityRecommendations, type CapabilityRoleFilter } from "../role-capability-recommendations";

type CatalogConnection = {
  id: string;
  catalogId: string;
  connectionLabel: string | null;
  status: string;
  health?: string;
  authMode: string;
  visibility: "private" | "workspace";
  name: string;
  endpoint: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json", ...init.headers } } : {}),
  });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

/** Connect curated vendor MCPs (OAuth or bearer fallback) from Integrations. */
export function CuratedMcpConnections({ onChanged }: { onChanged?: () => void }): JSX.Element {
  const changed = useRef(onChanged); changed.current = onChanged;
  const [connections, setConnections] = useState<CatalogConnection[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<Record<string, "private" | "workspace">>({});
  const [bearer, setBearer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<CapabilityRoleFilter>("all");
  const [oauthLinks, setOauthLinks] = useState<Record<string, string>>({});

  const vendors = CURATED_MCP_VENDORS.filter((vendor) => role === "all" || roleCapabilityRecommendations(role).mcpCatalogIds.includes(vendor.catalogId));

  const refresh = useCallback(async () => {
    const body = await request<{ connections?: CatalogConnection[] }>("/api/v1/mcp/catalog-connections");
    setConnections(Array.isArray(body.connections) ? body.connections : []);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const focus = () => { void refresh().then(() => changed.current?.()).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      onChanged?.();
      setNotice(success);
    } catch (cause) {
      await refresh().catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectionsFor = (vendor: CuratedMcpVendor) =>
    connections.filter((connection) => connection.catalogId === vendor.catalogId);

  return (
    <section className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]">
      <div className="border-b border-[var(--border-1)] px-4 py-3">
        <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          Custom MCP connections
        </p>
        <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">
          {CURATED_MCP_VENDORS.length} remote MCP presets. Sign-in depends on deployment and vendor support; nothing connects automatically. Labels keep multi-account
          connections separate (for example <span className="font-mono">stripe:prod</span>).
        </p>
        <div className="mt-3"><RoleCapabilityFilter value={role} onChange={setRole} label="MCP presets for role" /></div>
        <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">After sign-in, <a href="/agents/" className="text-[var(--primary)] underline">discover and review exact tools</a>, then <a href="/employee-tools/" className="text-[var(--primary)] underline">grant selected employee resources</a>. Saved credentials alone do not enable employee tools. Workspace visibility does not grant tool access.</p>
        <button type="button" disabled={busy !== null} className="mt-3 min-h-11 border border-[var(--border-1)] px-3 text-xs" onClick={() => void run("refresh", async () => {}, "Connection status refreshed.")}>Refresh connection status</button>
      </div>
      {error ? <p className="px-4 py-2 text-xs text-[var(--danger-fg)]">{error}</p> : null}
      {notice ? <p className="px-4 py-2 text-xs text-[var(--success-fg)]">{notice}</p> : null}
      {vendors.map((vendor) => (
        <div key={vendor.catalogId} id={`mcp-preset-${vendor.catalogId}`} className="scroll-mt-4 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <IntegrationLogo providerKey={vendor.catalogId} /><span className="text-[13px] font-semibold text-[var(--fg)]">{vendor.name}</span>
            <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{vendor.endpoint}</span>
          </div>
          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{vendor.setupNotice} <a href={vendor.docsUrl} target="_blank" rel="noopener noreferrer" className="underline">Official setup documentation</a></p>
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted-foreground-2)]">
            {connectionsFor(vendor).length === 0 ? (
              <li>No connections yet.</li>
            ) : (
              connectionsFor(vendor).map((connection) => (
                <li key={connection.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[var(--fg)]">
                    {vendor.catalogId}:{connection.connectionLabel ?? "default"}
                  </span>
                  <span>{connection.status}</span><span>health: {connection.health ?? "unknown"}</span>
                  <span>{connection.visibility}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    className="border border-[var(--border-1)] px-2 py-0.5 font-mono text-[10px] hover:border-[var(--primary)] disabled:opacity-50"
                    onClick={() =>
                      void run(`revoke-${connection.id}`, async () => {
                        await request(`/api/v1/mcp/servers/${connection.id}/revoke`, { method: "POST", body: "{}" });
                      }, "Connection revoked.")
                    }
                  >
                    Revoke
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-[11px]">
              Label
              <input
                value={labels[vendor.catalogId] ?? ""}
                onChange={(event) => setLabels((current) => ({ ...current, [vendor.catalogId]: event.target.value }))}
                placeholder="prod"
                className="border border-[var(--border-1)] bg-[var(--panel)] px-2 py-1 font-mono text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              Visibility
              <select
                value={visibility[vendor.catalogId] ?? "private"}
                onChange={(event) =>
                  setVisibility((current) => ({
                    ...current,
                    [vendor.catalogId]: event.target.value as "private" | "workspace",
                  }))
                }
                className="border border-[var(--border-1)] bg-[var(--panel)] px-2 py-1 text-xs"
              >
                <option value="private">Private</option>
                <option value="workspace">Workspace</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] sm:col-span-2">
              {vendor.connectionMethods.includes("oauth") ? "Bearer fallback (optional)" : "Bearer token"}
              <input
                type="password"
                disabled={!vendor.connectionMethods.includes("bearer")}
                value={bearer[vendor.catalogId] ?? ""}
                onChange={(event) => setBearer((current) => ({ ...current, [vendor.catalogId]: event.target.value }))}
                placeholder={vendor.connectionMethods.includes("oauth") ? "Paste vendor MCP bearer if OAuth client is not configured" : "Paste a restricted vendor token"}
                className="border border-[var(--border-1)] bg-[var(--panel)] px-2 py-1 font-mono text-xs"
              />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {vendor.connectionMethods.includes("oauth") ? <button
              type="button"
              disabled={busy !== null}
              className="border border-[var(--border-1)] bg-[var(--panel)] px-3 py-1.5 text-[10px] font-mono hover:border-[var(--primary)] disabled:opacity-50"
              onClick={() =>
                void run(
                  `oauth-${vendor.catalogId}`,
                  async () => {
                    const label = (labels[vendor.catalogId] ?? "").trim();
                    if (!label) throw new Error("connection_label_required");
                    const redirectUri = `${window.location.origin}/api/v1/mcp/oauth/callback`;
                    const created = await request<{ server: { id: string } }>("/api/v1/mcp/servers", {
                      method: "POST",
                      body: JSON.stringify({
                        name: `${vendor.name} ${label}`,
                        transport: "streamable_http",
                        url: vendor.endpoint,
                        catalogId: vendor.catalogId,
                        connectionLabel: label,
                        visibility: visibility[vendor.catalogId] ?? "private",
                        authMode: "oauth",
                        credentialRef: null,
                      }),
                    });
                    try {
                    const begin = await request<{ authorizationUrl: string }>(
                      `/api/v1/mcp/servers/${created.server.id}/oauth/begin`,
                      { method: "POST", body: JSON.stringify({ redirectUri }) },
                    );
                    const target = new URL(begin.authorizationUrl);
                    if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new Error("OAuth returned an unsafe redirect URL.");
                    setOauthLinks((current) => ({ ...current, [vendor.catalogId]: target.href }));
                    } catch (cause) {
                      await request(`/api/v1/mcp/servers/${created.server.id}`, { method: "DELETE" }).catch(() => {});
                      throw cause;
                    }
                  },
                  "OAuth sign-in link ready. Continue sign-in, then refresh connection status.",
                )
              }
            >
              Connect with OAuth
            </button> : null}
            <button
              type="button"
              disabled={busy !== null || !vendor.connectionMethods.includes("bearer") || !(bearer[vendor.catalogId] ?? "").trim()}
              className="border border-[var(--border-1)] bg-[var(--panel)] px-3 py-1.5 text-[10px] font-mono hover:border-[var(--primary)] disabled:opacity-50"
              onClick={() =>
                void run(
                  `bearer-${vendor.catalogId}`,
                  async () => {
                    const label = (labels[vendor.catalogId] ?? "").trim();
                    if (!label) throw new Error("connection_label_required");
                    const created = await request<{ server: { id: string } }>("/api/v1/mcp/servers", {
                      method: "POST",
                      body: JSON.stringify({
                        name: `${vendor.name} ${label}`,
                        transport: "streamable_http",
                        url: vendor.endpoint,
                        catalogId: vendor.catalogId,
                        connectionLabel: label,
                        visibility: visibility[vendor.catalogId] ?? "private",
                        authMode: "oauth",
                        credentialRef: null,
                      }),
                    });
                    await request(`/api/v1/mcp/servers/${created.server.id}/bearer`, {
                      method: "POST",
                      body: JSON.stringify({ token: bearer[vendor.catalogId] }),
                    }).catch(async (cause: unknown) => {
                      await request(`/api/v1/mcp/servers/${created.server.id}`, { method: "DELETE" }).catch(() => {});
                      throw cause;
                    });
                    setBearer((current) => ({ ...current, [vendor.catalogId]: "" }));
                    await request(`/api/v1/mcp/servers/${created.server.id}/discover`, { method: "POST", body: "{}" });
                  },
                  "Bearer saved — discover tools below in External MCP.",
                )
              }
            >
              {vendor.connectionMethods.includes("oauth") ? "Save bearer fallback" : "Save bearer token"}
            </button>
            {oauthLinks[vendor.catalogId] ? <a href={oauthLinks[vendor.catalogId]} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center border border-[var(--border-1)] px-3 text-xs underline">Continue {vendor.name} sign-in</a> : null}
          </div>
        </div>
      ))}
    </section>
  );
}
