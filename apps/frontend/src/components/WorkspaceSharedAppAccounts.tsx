import { IntegrationLogo } from "./IntegrationLogo";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { IntegrationProviderCatalogItem, WorkspaceIntegrationConnection, TeamWorkspaceRole } from "@shiba/shared";
import { workspaceAppConnections, disconnectWorkspaceApp, workspaceAccessChanged } from "../workspace-integrations-client";
import { useWorkspaceIntegrationOAuth } from "../workspace-integration-oauth";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";
import { WorkspaceAppGrantEditor } from "./WorkspaceAppGrantEditor";
import { WorkspaceAppActions } from "./WorkspaceAppActions";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";

export function WorkspaceSharedAppAccounts({ workspaceId, workspaceName, actorId, role, isCurrent, onChanged }: {
  workspaceId: string; workspaceName?: string; actorId?: string | null; role?: TeamWorkspaceRole;
  isCurrent: () => boolean; onChanged?: () => void;
}): JSX.Element {
  const [connections, setConnections] = useState<WorkspaceIntegrationConnection[]>([]);
  const [serverManager, setServerManager] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false), [consent, setConsent] = useState<IntegrationProviderCatalogItem | null>(null);
  const [accepted, setAccepted] = useState(false), [busy, setBusy] = useState<string | null>(null);
  const [grantAccount, setGrantAccount] = useState<WorkspaceIntegrationConnection | null>(null);
  const alive = useRef(false), controller = useRef(new AbortController()), epoch = useRef(0), operation = useRef(false);
  const scope = useRef(isCurrent); scope.current = isCurrent;
  const active = useCallback(() => alive.current && scope.current() && !controller.current.signal.aborted, []);
  const clearAccess = useCallback(() => {
    if (!active()) return;
    setConnections([]); setServerManager(false); setConsent(null); setAccepted(false); setGrantAccount(null); setBrowse(false);
    setError("Workspace access or permission changed. Refresh before continuing.");
  }, [active]);
  const canManage = serverManager && (role === "owner" || role === "admin");
  const refresh = useCallback(async () => {
    if (!active()) return;
    const generation = ++epoch.current;
    setLoading(true); setConnections([]); setGrantAccount(null); setError(null);
    try {
      const body = await workspaceAppConnections(workspaceId, controller.current.signal);
      if (!active() || generation !== epoch.current) return;
      setConnections(body.connections); setServerManager(body.canManage);
    } catch (cause) {
      if (active() && generation === epoch.current) {
        if (workspaceAccessChanged(cause)) clearAccess();
        setError(cause instanceof Error ? cause.message : "Workspace accounts are unavailable.");
      }
    } finally { if (active() && generation === epoch.current) setLoading(false); }
  }, [active, clearAccess, workspaceId]);
  const oauth = useWorkspaceIntegrationOAuth({ workspaceId, actorId, canManage, onAccessLost: clearAccess,
    onConfirmed: () => { if (active()) { void refresh(); onChanged?.(); } },
  });
  useEffect(() => {
    alive.current = true; const abort = new AbortController(); controller.current = abort;
    void refresh();
    return () => { alive.current = false; epoch.current++; abort.abort(); };
  }, [refresh]);
  const disconnect = async (connection: WorkspaceIntegrationConnection) => {
    if (!active() || !canManage || operation.current) return;
    operation.current = true; setBusy(connection.id); setError(null); setNotice(null);
    try {
      const body = await disconnectWorkspaceApp(workspaceId, connection, controller.current.signal);
      if (!active()) return;
      await refresh();
      if (active()) { setNotice(body.connection.state === "revoked" ? "Workspace account revoked. Existing grants cannot use it. Reconnecting requires fresh consent." : "Disconnect was not confirmed. Review the current account state before another action."); onChanged?.(); }
    } catch (cause) {
      if (active()) { if (workspaceAccessChanged(cause)) clearAccess(); setError(cause instanceof Error ? cause.message : "Disconnect is unavailable."); }
    } finally { if (active()) { operation.current = false; setBusy(null); } }
  };
  const chooseConsent = (item: IntegrationProviderCatalogItem) => {
    if (!canManage || !active()) return;
    setBrowse(false); setAccepted(false); setConsent(item); setError(null); setNotice(null);
  };
  return <section aria-label="Workspace-shared app accounts" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--paper)] p-4 text-[var(--ink)] lg:p-8"><div className="mx-auto grid w-full max-w-6xl gap-4">
    <header><h2 className="text-xl">Workspace-shared app accounts</h2><p className="mt-2 max-w-3xl text-sm text-[var(--ink-2)]">These accounts are explicitly shared within {workspaceName ?? "this workspace"}. This is Shiba sharing scope, not proof of vendor or company ownership. Personal accounts are never copied or transferred here.</p></header>
    <p className="text-xs text-[var(--ink-2)]">Sharing pauses if the original consenting manager is removed or their membership changes. Another manager must disconnect and give fresh consent. Account configuration, upstream authorization, action health and employee grants are distinct.</p>
    <div className="flex flex-wrap gap-2">{canManage && <button type="button" className={BUTTON} disabled={Boolean(oauth.connectingKey) || Boolean(busy)} onClick={() => setBrowse(true)}>Browse workspace app catalog</button>}<button type="button" className={BUTTON} disabled={loading || Boolean(busy)} onClick={() => { void refresh(); }}>Refresh workspace accounts</button></div>
    {(error || oauth.error) && <p role="alert" className="text-xs text-[var(--danger)]">{error ?? oauth.error}</p>}{(notice || oauth.notice) && <p role="status" className="text-xs">{notice ?? oauth.notice}</p>}
    {consent && canManage && <section aria-label="Confirm workspace sharing" className="border border-[var(--line)] bg-[var(--card)] p-4"><h3 className="text-lg">Share a new {consent.name} account</h3><p className="mt-2 text-xs text-[var(--ink-2)]">Continue only with an account you are authorized to share. The app will ask for its own access consent. Shiba will record this workspace audience and your current manager grant; employees receive no permissions automatically.</p><label className="mt-3 flex min-h-11 items-center gap-2 break-words text-xs"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />I authorize this new account to be shared with explicitly granted members and employees in {workspaceName ?? "this workspace"}.</label><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={!accepted || Boolean(oauth.connectingKey)} onClick={() => { if (!accepted || !active()) return; const item = consent; setConsent(null); setAccepted(false); void oauth.beginConnect(item); }}>Continue to app sign-in</button><button type="button" className={BUTTON} onClick={() => { setConsent(null); setAccepted(false); }}>Cancel sharing</button></div></section>}
    {loading ? <p role="status" className="text-xs">Loading current workspace grants…</p> : connections.length === 0 ? <p className="border border-dashed border-[var(--line)] p-5 text-sm">{canManage ? "No workspace-shared accounts are configured. Choose an app, then review the sharing consent." : "No workspace accounts are currently granted to you. Ask a workspace manager for an exact employee and member grant."}</p> : <ul className="grid gap-3">{connections.map((connection) => <li key={connection.id} className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-4"><div className="flex items-center gap-2"><IntegrationLogo providerKey={connection.providerKey} /><h3 className="break-words text-sm font-semibold">{connection.providerKey}</h3></div><p className="mt-1 break-words text-xs text-[var(--ink-2)]">{connection.identityLabel ?? "Workspace-shared account"}</p><dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"><div><dt className="font-semibold">Configuration</dt><dd>{connection.state} · v{connection.version}</dd></div><div><dt className="font-semibold">Upstream authorization</dt><dd>{connection.upstreamReady ? "Reported by integration service" : "Not confirmed"}</dd></div><div><dt className="font-semibold">Action health</dt><dd>{connection.health === "error" ? "Service check failed" : "Live action unverified"}</dd></div><div><dt className="font-semibold">Employee grants</dt><dd>{connection.grantCount} explicit grant{connection.grantCount === 1 ? "" : "s"}</dd></div></dl>{canManage && <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={connection.state !== "active" || !connection.upstreamReady || Boolean(busy)} onClick={() => setGrantAccount(connection)}>Review {connection.providerKey} permissions</button><button type="button" className={BUTTON} disabled={["revoked", "revoking", "unknown"].includes(connection.state) || Boolean(busy) || Boolean(oauth.connectingKey)} onClick={() => { void disconnect(connection); }}>Disconnect {connection.providerKey}</button></div>}{grantAccount?.id === connection.id && canManage && <WorkspaceAppGrantEditor key={`${actorId}:${workspaceId}:${connection.id}:${connection.version}`} workspaceId={workspaceId} connection={connection} isCurrent={active} onClose={() => setGrantAccount(null)} onAccessLost={clearAccess} onChanged={() => { if (active()) { setNotice("Workspace permissions updated. Each external action still needs separate human approval."); void refresh(); onChanged?.(); } }} />}</li>)}</ul>}
    {!loading && connections.length > 0 && <WorkspaceAppActions key={`${actorId}:${workspaceId}`} workspaceId={workspaceId} actorId={actorId} canManage={canManage} connections={connections} isCurrent={active} onAccessLost={clearAccess} />}
    <p className="text-xs text-[var(--ink-2)]">A catalog entry is an available setup path, not a connected account. A connected badge is never permission for an external write. Review each frozen action payload before execution.</p>
    <IntegrationsBrowseCatalogDialog open={browse && canManage} workspaceId={workspaceId} actorId={actorId} onClose={() => setBrowse(false)} onAccessLost={clearAccess} onConnect={chooseConsent} connectingKey={oauth.connectingKey} />
  </div></section>;
}
