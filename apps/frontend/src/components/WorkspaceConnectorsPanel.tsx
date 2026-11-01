import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
import {
  extensionsApi,
  type ExtensionScope,
  type ExtensionView,
  type WorkspaceConnector,
} from "../extensions-api";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";
import { IntegrationCatalogDirectory } from "./IntegrationCatalogDirectory";
import { CuratedMcpConnections } from "./CuratedMcpConnections";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";

const buttonClass = "min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold text-[var(--fg)] hover:bg-[var(--card-hover)] disabled:opacity-50";
const views: Array<{ id: ExtensionView; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "workspace", label: "Workspace" },
  { id: "archived", label: "Archived" },
];

export function WorkspaceConnectorsPanel({ bindingInputs, onChanged }: { bindingInputs: IntegrationBindingInputs; onChanged?: () => void }): JSX.Element {
  const [view, setView] = useState<ExtensionView>("personal");
  const [connectors, setConnectors] = useState<WorkspaceConnector[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingOAuth = useRef<{ providerKey: string; scope: ExtensionScope } | null>(null);
  const currentScope: ExtensionScope = view === "workspace" ? "workspace" : "personal";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await extensionsApi.listConnectors(view);
      setConnectors(Array.isArray(result.connectors) ? result.connectors : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connectors could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const linkedKeys = useMemo(() => new Set(connectors.map((connector) => connector.providerKey)), [connectors]);

  const filteredConnectors = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter(
      (c) =>
        c.providerKey.toLowerCase().includes(q) ||
        (c.identityLabel && c.identityLabel.toLowerCase().includes(q)),
    );
  }, [connectors, searchQuery]);

  const linkAccount = useCallback(async (providerKey: string, connectedAccountId: string, scope = currentScope) => {
    setBusyId(providerKey);
    setError(null);
    setNotice(null);
    try {
      await extensionsApi.addConnector({ providerKey, connectedAccountId, scope });
      setNotice(`${providerKey} added to ${scope === "workspace" ? "Workspace" : "Personal"}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connector could not be added.");
    } finally {
      setBusyId(null);
    }
  }, [currentScope, refresh]);

  const onLinkExisting = useCallback((item: IntegrationProviderCatalogItem) => {
    if (!item.connectionId) return;
    void linkAccount(item.providerKey, item.connectionId);
  }, [linkAccount]);

  const onOAuthComplete = useCallback(async () => {
    const pending = pendingOAuth.current;
    if (!pending) {
      void refresh();
      return;
    }
    try {
      const result = await extensionsApi.listOpenConnectorConnections();
      const account = result.connections.find((connection) => connection.providerKey === pending.providerKey);
      if (!account) throw new Error("OpenConnector did not report a connected account. Refresh and try again.");
      await linkAccount(pending.providerKey, account.id, pending.scope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenConnector connection could not be linked.");
    } finally {
      pendingOAuth.current = null;
    }
  }, [linkAccount, refresh]);

  const mutate = async (connector: WorkspaceConnector, action: "archive" | "restore" | "remove") => {
    setBusyId(connector.id);
    setError(null);
    setNotice(null);
    try {
      if (action === "archive") await extensionsApi.archiveConnector(connector.id);
      if (action === "restore") await extensionsApi.restoreConnector(connector.id);
      if (action === "remove") await extensionsApi.removeConnector(connector.id);
      setNotice(`${connector.providerKey} ${action === "remove" ? "removed" : `${action}d`}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connector could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  const moveScope = async (connector: WorkspaceConnector, targetScope: ExtensionScope) => {
    setBusyId(connector.id);
    setError(null);
    setNotice(null);
    try {
      await extensionsApi.moveConnector(connector.id, targetScope);
      setNotice(`${connector.providerKey} moved to ${targetScope === "workspace" ? "Workspace" : "Personal"}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to change connector scope.");
    } finally {
      setBusyId(null);
    }
  };

  const disconnectIntegration = async (connector: WorkspaceConnector) => {
    setBusyId(connector.id);
    setError(null);
    setNotice(null);
    try {
      await extensionsApi.disconnectOpenConnector(connector.providerKey);
      await extensionsApi.removeConnector(connector.id);
      setNotice(`${connector.providerKey} disconnected and removed.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to disconnect integration.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section aria-label="Workspace connectors" className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-4 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h3 className="text-sm font-semibold text-[var(--fg)]">{view === "workspace" ? "Workspace connectors" : view === "archived" ? "Archived connectors" : "Personal connectors"}</h3><p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Connect apps through OpenConnector, then choose whether each connection belongs to you or the workspace.</p></div>
            <div className="flex gap-2">
              <button type="button" className={buttonClass} disabled={view === "archived"} onClick={() => setBrowseOpen(true)}>Browse catalog modal</button>
              <button type="button" className={buttonClass} disabled={view === "archived"} onClick={() => document.getElementById("openconnector-catalog")?.scrollIntoView?.({ behavior: "smooth", block: "start" })}>Connect an app</button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Connector view">
              {views.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => setView(item.id)} className={`min-h-11 rounded px-3 text-xs font-semibold ${view === item.id ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted-foreground-2)] hover:bg-[var(--card-hover)]"}`}>{item.label}</button>)}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search connectors…"
                aria-label="Search connectors"
                className="min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:border-[var(--primary)] focus:outline-none"
              />
              <button type="button" className={buttonClass} disabled={loading} onClick={() => void refresh()}>Refresh</button>
            </div>
          </div>
          {error ? <p role="alert" className="mt-3 rounded border border-[var(--destructive)]/40 px-3 py-2 text-xs text-[var(--destructive)]">{error}</p> : null}
          {notice ? <p role="status" className="mt-3 text-xs text-[var(--muted-foreground-2)]">{notice}</p> : null}
          <div className="mt-4 grid gap-2">
            {loading ? <p role="status" className="text-xs text-[var(--muted-foreground-2)]">Loading connectors…</p> : null}
            {!loading && filteredConnectors.length === 0 ? (
              <p className="rounded border border-dashed border-[var(--border-1)] p-5 text-center text-xs text-[var(--muted-foreground-2)]">
                {searchQuery ? `No connectors match "${searchQuery}".` : view === "archived" ? "No archived connectors." : "No connectors in this view yet. Browse the OpenConnector catalog below to connect an app."}
              </p>
            ) : null}
            {filteredConnectors.map((connector) => (
              <article key={connector.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--border-1)] bg-[var(--card)] px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="size-2 rounded-full bg-[var(--success)]" aria-hidden="true" />
                  <div>
                    <h4 className="text-sm font-semibold text-[var(--fg)]">{connector.providerKey}</h4>
                    <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{connector.identityLabel || "OpenConnector account"} · {connector.scope}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {view === "archived" ? (
                    <button type="button" className={buttonClass} disabled={busyId === connector.id} onClick={() => void mutate(connector, "restore")}>Restore</button>
                  ) : (
                    <>
                      <button type="button" className={buttonClass} disabled={busyId === connector.id} onClick={() => void moveScope(connector, connector.scope === "personal" ? "workspace" : "personal")}>
                        {connector.scope === "personal" ? "Move to Workspace" : "Move to Personal"}
                      </button>
                      <button type="button" className={buttonClass} disabled={busyId === connector.id} onClick={() => void mutate(connector, "archive")}>Archive</button>
                      <button type="button" className={buttonClass} disabled={busyId === connector.id} onClick={() => void disconnectIntegration(connector)}>Disconnect</button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
      {view !== "archived" ? (
        <div className="flex flex-col gap-6 p-4 lg:p-8">
          <div className="mx-auto w-full max-w-6xl"><CuratedMcpConnections onChanged={() => { onChanged?.(); void refresh(); }} /></div>
          <div id="openconnector-catalog" className="min-h-[32rem]">
            <IntegrationCatalogDirectory
              bindingInputs={bindingInputs}
              linkedConnectorKeys={linkedKeys}
              linkActionLabel={`Add to ${currentScope === "workspace" ? "Workspace" : "Personal"}`}
              linkingKey={busyId}
              onLinkExisting={onLinkExisting}
              onConnectStarted={(providerKey) => { pendingOAuth.current = { providerKey, scope: currentScope }; }}
              onOAuthComplete={() => { void onOAuthComplete(); }}
            />
          </div>
        </div>
      ) : null}
      <IntegrationsBrowseCatalogDialog
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        linkedConnectorKeys={linkedKeys}
        linkActionLabel={`Add to ${currentScope === "workspace" ? "Workspace" : "Personal"}`}
        linkingKey={busyId}
        onLinkExisting={onLinkExisting}
        onConnect={(item) => {
          pendingOAuth.current = { providerKey: item.providerKey, scope: currentScope };
        }}
      />
    </div>
  );
}
