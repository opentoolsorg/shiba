import { useCallback, useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import {
  extensionsApi,
  type ExtensionScope,
  type ExtensionView,
  type McpAuthType,
  type McpExtensionServer,
  type McpServerInput,
  type McpTestResult,
  type McpToolPolicy,
  type McpTransport,
} from "../extensions-api";

const fieldClass = "min-h-11 w-full rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)]";
const buttonClass = "min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-semibold text-[var(--fg)] hover:bg-[var(--card-hover)] disabled:opacity-50";
const views: Array<{ id: ExtensionView; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "workspace", label: "Workspace" },
  { id: "archived", label: "Archived" },
];

interface McpFormState {
  name: string;
  description: string;
  url: string;
  transport: McpTransport;
  enabled: boolean;
  authType: McpAuthType;
  bearerToken: string;
  headerName: string;
  headerValue: string;
  timeoutMs: string;
  defaultToolPolicy: McpToolPolicy;
}

const emptyForm = (): McpFormState => ({
  name: "",
  description: "",
  url: "",
  transport: "streamable-http",
  enabled: true,
  authType: "none",
  bearerToken: "",
  headerName: "",
  headerValue: "",
  timeoutMs: "",
  defaultToolPolicy: "allow",
});

function formFor(server: McpExtensionServer): McpFormState {
  return {
    ...emptyForm(),
    name: server.name,
    description: server.description ?? "",
    url: server.url,
    transport: server.transport,
    enabled: server.enabled,
    authType: server.authType,
    timeoutMs: server.timeoutMs ? String(server.timeoutMs) : "",
    defaultToolPolicy: server.defaultToolPolicy,
  };
}

function serverInput(form: McpFormState, scope: ExtensionScope): McpServerInput {
  const authConfig = form.authType === "bearer" && form.bearerToken
    ? { bearerToken: form.bearerToken }
    : form.authType === "header" && form.headerName && form.headerValue
      ? { headerName: form.headerName, headerValue: form.headerValue }
      : undefined;
  const timeoutMs = Number(form.timeoutMs);
  return {
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    url: form.url.trim(),
    transport: form.transport,
    enabled: form.enabled,
    authType: form.authType,
    ...(authConfig ? { authConfig } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    defaultToolPolicy: form.defaultToolPolicy,
    scope,
  };
}

export function ExtensionMcpServersView(): JSX.Element {
  const [view, setView] = useState<ExtensionView>("personal");
  const [servers, setServers] = useState<McpExtensionServer[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialogServer, setDialogServer] = useState<McpExtensionServer | null | undefined>(undefined);
  const [form, setForm] = useState<McpFormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await extensionsApi.listMcpServers(view);
      setServers(Array.isArray(result.servers) ? result.servers : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP servers could not be loaded.");
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

  const openCreate = () => {
    setDialogServer(null);
    setForm(emptyForm());
    setOauthUrl(null);
    setTestResult(null);
    setError(null);
  };
  const openEdit = (server: McpExtensionServer) => {
    setDialogServer(server);
    setForm(formFor(server));
    setOauthUrl(null);
    setTestResult(null);
    setError(null);
  };
  const closeDialog = () => { if (!busy) setDialogServer(undefined); };

  const filteredServers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        s.url.toLowerCase().includes(q),
    );
  }, [servers, searchQuery]);

  const persist = async (): Promise<string> => {
    const input = serverInput(form, view === "workspace" ? "workspace" : "personal");
    if (dialogServer?.id) {
      const result = await extensionsApi.updateMcpServer(dialogServer.id, input);
      setServers((current) => current.map((row) => row.id === dialogServer.id ? result.server : row));
      return result.server.id;
    }
    const result = await extensionsApi.createMcpServer(input);
    setServers((current) => [result.server, ...current]);
    setDialogServer(result.server);
    return result.server.id;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await persist();
      setNotice("MCP server saved.");
      setDialogServer(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP server could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const handleTestConnection = async () => {
    if (testing || !form.url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const input = serverInput(form, view === "workspace" ? "workspace" : "personal");
      const res = await extensionsApi.testMcpServer({ ...input, id: dialogServer?.id });
      setTestResult(res);
    } catch (cause) {
      setTestResult({
        ok: false,
        message: cause instanceof Error ? cause.message : "Connection test failed.",
      });
    } finally {
      setTesting(false);
    }
  };

  const startOAuth = async () => {
    const popup = window.open("about:blank", "_blank");
    setBusy(true);
    setError(null);
    setOauthUrl(null);
    try {
      const id = await persist();
      const result = await extensionsApi.startMcpOAuth(id);
      const target = new URL(result.redirectUrl, window.location.origin);
      if (target.protocol !== "https:") throw new Error("The OAuth service returned an unsafe redirect URL.");
      if (popup) popup.location.href = target.href;
      else setOauthUrl(target.href);
      setNotice("OAuth sign-in opened. Finish connecting in the provider window.");
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : "OAuth could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const moveScope = async (server: McpExtensionServer, targetScope: ExtensionScope) => {
    setBusy(true);
    setError(null);
    try {
      await extensionsApi.updateMcpServer(server.id, { scope: targetScope });
      setNotice(`Moved to ${targetScope === "workspace" ? "Workspace" : "Personal"}.`);
      await refresh();
      if (dialogServer) setDialogServer(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to move scope.");
    } finally {
      setBusy(false);
    }
  };

  const mutateServer = async (server: McpExtensionServer, action: "toggle" | "archive" | "restore" | "delete") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "toggle") await extensionsApi.updateMcpServer(server.id, { enabled: !server.enabled });
      if (action === "archive") await extensionsApi.archiveMcpServer(server.id);
      if (action === "restore") await extensionsApi.restoreMcpServer(server.id);
      if (action === "delete") await extensionsApi.deleteMcpServer(server.id);
      setNotice(action === "toggle" ? `Server ${server.enabled ? "disabled" : "enabled"}.` : `Server ${action === "delete" ? "deleted" : `${action}d`}.`);
      if (action === "delete") setDialogServer(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP server could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-4 py-3 lg:px-8">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fg)]">MCP servers</h3>
          <p className="text-xs text-[var(--muted-foreground-2)]">Manage remote servers and their default tool policy.</p>
        </div>
        {view !== "archived" ? <button type="button" className={buttonClass} onClick={openCreate}>Add server</button> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-3 lg:px-8">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="MCP server view">
          {views.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} onClick={() => setView(item.id)} className={`min-h-11 rounded px-3 text-xs font-semibold ${view === item.id ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted-foreground-2)] hover:bg-[var(--card-hover)]"}`}>{item.label}</button>)}
        </div>
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search servers…"
          aria-label="Search servers"
          className="min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs text-[var(--fg)] placeholder:text-[var(--muted-foreground-3)] focus:border-[var(--primary)] focus:outline-none"
        />
        <button type="button" className={buttonClass} disabled={loading} onClick={() => void refresh()}>Refresh</button>
      </div>
      </div>
      {error ? <p role="alert" className="mx-4 mt-3 rounded border border-[var(--destructive)]/40 px-3 py-2 text-xs text-[var(--destructive)] lg:mx-8">{error}</p> : null}
      {notice ? <p role="status" className="mx-4 mt-3 text-xs text-[var(--muted-foreground-2)] lg:mx-8">{notice}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto grid max-w-6xl gap-3 md:grid-cols-2 xl:grid-cols-3">
          {loading ? <p role="status" className="text-xs text-[var(--muted-foreground-2)]">Loading MCP servers…</p> : null}
        {!loading && !filteredServers.length ? <div className="col-span-full rounded border border-dashed border-[var(--border-1)] p-8 text-center text-sm text-[var(--muted-foreground-2)]">{searchQuery ? `No servers match "${searchQuery}".` : view === "archived" ? "No archived MCP servers." : "No MCP servers yet. Add a remote server to get started."}</div> : null}
        {filteredServers.map((server: McpExtensionServer) => (
            <article key={server.id} className="flex min-h-52 flex-col gap-4 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${server.enabled ? "bg-[var(--success)]" : "bg-[var(--muted-foreground-3)]"}`} title={server.enabled ? "Active" : "Disabled"} />
                  <h4 className="min-w-0 break-words text-sm font-semibold text-[var(--fg)]">{server.name}</h4>
                  <span className="rounded border border-[var(--border-1)] px-2 py-0.5 font-mono text-[10px] text-[var(--muted-foreground-2)]">{server.enabled ? "Enabled" : "Disabled"}</span>
                </div>
                {server.description ? <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{server.description}</p> : null}
                <code className="mt-2 block break-all text-[11px] text-[var(--muted-foreground-2)]">{server.url}</code>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-y border-[var(--border-1)] py-3 text-xs">
                <div><dt className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-3)]">Transport</dt><dd className="mt-0.5 text-[var(--fg)]">{server.transport === "sse" ? "SSE" : "Streamable HTTP"}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-3)]">Authentication</dt><dd className="mt-0.5 text-[var(--fg)]">{server.authType === "oauth" ? `OAuth: ${server.oauthStatus ?? "disconnected"}` : server.authType === "none" ? "None" : server.hasAuth ? `${server.authType} configured` : `${server.authType} · not set`}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-3)]">Default tool policy</dt><dd className="mt-0.5 text-[var(--fg)]">{server.defaultToolPolicy.replaceAll("_", " ")}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground-3)]">Tools</dt><dd className="mt-0.5 text-[var(--fg)]">{server.toolCatalogCount}</dd></div>
              </dl>
              <div className="mt-auto flex flex-wrap gap-2">
                {view === "archived" ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void mutateServer(server, "restore")}>Restore</button> : <>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => openEdit(server)}>Edit</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void mutateServer(server, "toggle")}>{server.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void moveScope(server, server.scope === "personal" ? "workspace" : "personal")}>{server.scope === "personal" ? "Move to Workspace" : "Move to Personal"}</button>
                  {server.authType === "oauth" ? <button type="button" className={buttonClass} disabled={busy} onClick={() => { openEdit(server); }}>Connect OAuth</button> : null}
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void mutateServer(server, "archive")}>Archive</button>
                </>}
              </div>
            </article>
          ))}
        </div>
      </div>

      {dialogServer !== undefined ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="mcp-editor-title">
          <form className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--panel)] shadow-[var(--sh-overlay)]" onSubmit={(event) => void save(event)}>
            <div className="flex items-center justify-between border-b border-[var(--border-1)] px-5 py-4">
              <div><h3 id="mcp-editor-title" className="text-sm font-semibold text-[var(--fg)]">{dialogServer ? "Edit MCP server" : "Add MCP server"}</h3><p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Credentials are sent only to the authenticated extensions API and must be encrypted at rest by the backend.</p></div>
              <button type="button" className={buttonClass} disabled={busy} onClick={closeDialog}>Close</button>
            </div>
            {dialogServer ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] bg-[var(--card)] px-5 py-2.5 text-xs text-[var(--muted-foreground-2)]">
                <span>Scope: <strong>{dialogServer.scope}</strong></span>
                <div className="flex gap-2">
                  <button type="button" className="text-[var(--primary)] hover:underline" disabled={busy} onClick={() => void moveScope(dialogServer, dialogServer.scope === "personal" ? "workspace" : "personal")}>Move to {dialogServer.scope === "personal" ? "Workspace" : "Personal"}</button>
                </div>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
              <label className="block space-y-1 text-xs">Name<input className={fieldClass} value={form.name} required maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="block space-y-1 text-xs">Description<input className={fieldClass} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
              <label className="block space-y-1 text-xs">Server URL<input className={fieldClass} type="url" value={form.url} required placeholder="https://mcp.example.com/mcp" onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs">Transport<select className={fieldClass} value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as McpTransport })}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></select></label>
                <label className="block space-y-1 text-xs">Authentication<select className={fieldClass} value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value as McpAuthType })}><option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Custom header</option><option value="oauth">OAuth</option></select></label>
                <label className="block space-y-1 text-xs">Default tool policy<select className={fieldClass} value={form.defaultToolPolicy} onChange={(event) => setForm({ ...form, defaultToolPolicy: event.target.value as McpToolPolicy })}><option value="allow">Allow tools</option><option value="approval_required">Require approval</option><option value="deny">Deny tools</option></select></label>
                <label className="block space-y-1 text-xs">Timeout (ms)<input className={fieldClass} type="number" min="1" placeholder="30000" value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} /></label>
              </div>
              {form.authType === "bearer" ? <label className="block space-y-1 text-xs">Bearer token<input className={fieldClass} type="password" autoComplete="new-password" value={form.bearerToken} placeholder={dialogServer?.hasAuth ? "Saved token · leave blank to keep" : ""} onChange={(event) => setForm({ ...form, bearerToken: event.target.value })} /></label> : null}
              {form.authType === "header" ? <div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-1 text-xs">Header name<input className={fieldClass} value={form.headerName} placeholder="X-Api-Key" onChange={(event) => setForm({ ...form, headerName: event.target.value })} /></label><label className="block space-y-1 text-xs">Header value<input className={fieldClass} type="password" autoComplete="new-password" value={form.headerValue} placeholder={dialogServer?.hasAuth ? "Saved value · leave blank to keep" : ""} onChange={(event) => setForm({ ...form, headerValue: event.target.value })} /></label></div> : null}
              <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enable this server</label>
              {form.authType === "oauth" ? <div className="rounded border border-[var(--border-1)] p-3"><p className="text-xs text-[var(--muted-foreground-2)]">OAuth status: {dialogServer?.oauthStatus ?? "Not connected"}</p><button type="button" className={`${buttonClass} mt-2`} disabled={busy || !form.name.trim() || !form.url.trim()} onClick={() => void startOAuth()}>{dialogServer?.oauthStatus === "connected" ? "Reconnect with OAuth" : "Connect with OAuth"}</button>{oauthUrl ? <a className="ml-3 text-xs text-[var(--primary)] underline" href={oauthUrl} target="_blank" rel="noreferrer">Continue OAuth sign-in</a> : null}</div> : null}
              {testResult ? (
                <div className={`flex items-start gap-2 rounded p-3 text-xs ${testResult.ok ? "border border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]" : "border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]"}`}>
                  <span className="font-semibold">{testResult.ok ? "✓" : "!"}</span>
                  <div className="flex-1">
                    <span>{testResult.message}</span>
                    {testResult.requiresAuth && form.authType !== "oauth" ? <button type="button" onClick={() => setForm({ ...form, authType: "oauth" })} className="ml-2 underline">Switch to OAuth</button> : null}
                  </div>
                </div>
              ) : null}
              {error ? <p role="alert" className="text-xs text-[var(--destructive)]">{error}</p> : null}
              {notice ? <p role="status" className="text-xs text-[var(--muted-foreground-2)]">{notice}</p> : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-1)] px-5 py-3">
              {dialogServer ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void mutateServer(dialogServer, "delete")}>Delete server</button> : <span />}
              <div className="flex gap-2">
                <button type="button" className={buttonClass} disabled={testing || !form.url.trim()} onClick={() => void handleTestConnection()}>{testing ? "Testing…" : "Test connection"}</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={closeDialog}>Cancel</button>
                <button type="submit" className={`${buttonClass} border-[var(--primary)] text-[var(--primary)]`} disabled={busy || !form.name.trim() || !form.url.trim()}>{busy ? "Saving…" : dialogServer ? "Save changes" : "Add server"}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
