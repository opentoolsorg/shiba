import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { IntegrationProviderCatalogItem, IntegrationProviderConnection, TeamWorkspaceRole } from "@shiba/shared";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";
import { ownedAppConnections, useIntegrationOAuth } from "../integration-oauth";
import { IntegrationCatalogDirectory } from "./IntegrationCatalogDirectory";
import { CuratedMcpConnections } from "./CuratedMcpConnections";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";
import { OperatorEnrollmentReviews } from "./OperatorEnrollmentReviews";
import { WorkspaceSharedAppAccounts } from "./WorkspaceSharedAppAccounts";

const BUTTON =
  "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
export interface WorkspaceConnectorsPanelProps {
  bindingInputs: IntegrationBindingInputs;
  actorId?: string | null;
  onChanged?: () => void;
  onManagePermissions?: () => void;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRole?: TeamWorkspaceRole;
  allowPersonalScope?: boolean;
  onPersonalScope?: () => void;
  onChooseWorkspace?: () => void;
}

/** App credentials stay private; employee resource grants are configured separately. */
/** Manage private and workspace-owned app accounts without mixing their scopes. */
export function WorkspaceConnectorsPanel(props: WorkspaceConnectorsPanelProps): JSX.Element {
  const scope = `${props.actorId ?? "legacy"}\0${props.workspaceId ?? "personal"}\0${props.workspaceRole ?? "private"}`;
  const current = useRef(scope); current.current = scope;
  return <div className="flex h-full min-h-0 flex-1 flex-col">
    {(props.workspaceId || props.onChooseWorkspace) && <fieldset className="border-b border-[var(--line)] bg-[var(--card)] px-4 py-3 text-xs lg:px-8"><legend className="sr-only">App account ownership</legend><label className="flex flex-wrap items-center gap-3">Account ownership<select aria-label="App account ownership" value={props.workspaceId ? "workspace" : "personal"} className="min-h-11 min-w-0 max-w-full border border-[var(--input-line)] bg-[var(--paper)] px-3" onChange={(event) => { if (event.target.value === "personal") props.onPersonalScope?.(); else props.onChooseWorkspace?.(); }}><option value="personal" disabled={props.workspaceId ? !props.allowPersonalScope || !props.onPersonalScope : false}>Personal, only you</option><option value="workspace">Workspace-shared{props.workspaceName ? `, ${props.workspaceName}` : ", select a team"}</option></select></label><p className="mt-2 text-[var(--ink-2)]">{props.workspaceId ? props.allowPersonalScope ? "Personal account management opens your personal workspace. Accounts are never transferred by changing this selector." : "This invited session can use explicitly granted workspace accounts. Personal integration setup is unavailable here." : "Personal accounts stay private. Select a team workspace before starting a separate shared consent."}</p></fieldset>}
    {!props.workspaceId && <OperatorEnrollmentReviews actorId={props.actorId} />}
    {props.workspaceId ? <WorkspaceSharedAppAccounts key={scope} workspaceId={props.workspaceId} workspaceName={props.workspaceName} actorId={props.actorId} role={props.workspaceRole} isCurrent={() => current.current === scope} onChanged={props.onChanged} /> : <OwnedAppAccounts
      key={scope}
      {...props}
      isCurrent={() => current.current === scope}
    />}
  </div>;
}
/** The server re-verifies OAuth client readiness before replacing the unusable row. */
function reconnectItem(connection: IntegrationProviderConnection): IntegrationProviderCatalogItem {
  return { id: connection.providerKey, providerKey: connection.providerKey, name: connection.providerKey, description: "", source: "openconnector", connectable: true, isConnected: false };
}
/** Manage personal app accounts, including explicit disconnect and safe reconnect flows. */
function OwnedAppAccounts({
  bindingInputs,
  actorId,
  onChanged,
  onManagePermissions,
  isCurrent,
}: WorkspaceConnectorsPanelProps & { isCurrent: () => boolean }): JSX.Element {
  const [connections, setConnections] = useState<IntegrationProviderConnection[]>([]);
  const [search, setSearch] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const epoch = useRef(0),
    alive = useRef(true),
    operation = useRef(false);
  const abort = useRef(new AbortController());
  const scopeCheck = useRef(isCurrent);
  scopeCheck.current = isCurrent;
  const active = useCallback(
    () => alive.current && scopeCheck.current() && !abort.current.signal.aborted,
    [],
  );
  const refresh = useCallback(async () => {
    if (!active()) return;
    const generation = ++epoch.current;
    setLoading(true);
    setConnections([]);
    setError(null);
    try {
      const rows = await ownedAppConnections(abort.current.signal, true);
      if (active() && generation === epoch.current) setConnections(rows);
    } catch (cause) {
      if (active() && generation === epoch.current)
        setError(cause instanceof Error ? cause.message : "App accounts unavailable.");
    } finally {
      if (active() && generation === epoch.current) setLoading(false);
    }
  }, [active]);
  const oauth = useIntegrationOAuth({
    actorId,
    onVerified: () => {
      if (active()) {
        void refresh();
        setConnectionRevision((revision) => revision + 1);
        onChanged?.();
      }
    },
  });
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    abort.current = controller;
    if (actorId !== null) void refresh();
    else setLoading(false);
    const focus = () => {
      if (actorId !== null) void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      epoch.current++;
      controller.abort();
      window.removeEventListener("focus", focus);
    };
  }, [actorId, refresh]);
  const disconnect = async (connection: IntegrationProviderConnection) => {
    if (!active() || operation.current || actorId === null) return;
    operation.current = true;
    setBusy(connection.id);
    setError(null);
    setNotice(null);
    epoch.current++;
    try {
      const response = await fetch("/api/integrations/provider/disconnect", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.current.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerKey: connection.providerKey }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!active()) return;
      if (!response.ok || !body.ok)
        throw new Error(body.error ?? "Disconnect could not be confirmed.");
      await refresh();
      if (active()) {
        setConnectionRevision((revision) => revision + 1);
        setNotice(
          `${connection.providerKey} disconnected. Existing employee grants cannot use a disconnected account.`,
        );
        onChanged?.();
      }
    } catch (cause) {
      if (active()) {
        setConnections([]);
        setError(cause instanceof Error ? cause.message : "Disconnect unavailable.");
      }
    } finally {
      if (active()) {
        operation.current = false;
        setBusy(null);
      }
    }
  };
  const query = search.trim().toLowerCase();
  const shown = connections.filter((connection) =>
    [connection.providerKey, connection.identityLabel].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-[var(--ink)]">
      <section
        aria-label="Your app accounts"
        className="border-b border-[var(--line)] bg-[var(--card)] px-4 py-4 lg:px-8"
      >
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h3 className="text-lg">Your app accounts</h3>
              <p className="mt-1 max-w-3xl text-xs text-[var(--ink-2)]">
                These are the current authenticated owner's OpenConnector accounts. Linking an
                account does not share its credentials, grant employee access, or prove a successful
                live action.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={BUTTON}
                disabled={actorId === null}
                onClick={() => setBrowseOpen(true)}
              >
                Browse catalog
              </button>
              {onManagePermissions && (
                <button type="button" className={BUTTON} onClick={onManagePermissions}>
                  Review employee permissions
                </button>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              aria-label="Search app accounts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-h-11 min-w-0 flex-1 border border-[var(--input-line)] bg-[var(--paper)] px-3 text-sm"
              placeholder="Search your app accounts…"
            />
            <button
              type="button"
              className={BUTTON}
              disabled={loading || actorId === null}
              onClick={() => {
                void refresh();
              }}
            >
              Refresh accounts
            </button>
          </div>
          {(error || oauth.error) && (
            <p role="alert" className="mt-3 text-xs text-[var(--danger)]">
              {error ?? oauth.error}
            </p>
          )}
          {(notice || oauth.notice) && (
            <p role="status" className="mt-3 text-xs text-[var(--ink-2)]">
              {notice ?? oauth.notice}
            </p>
          )}
          {loading ? (
            <p role="status" className="mt-4 text-xs">
              Checking current owned accounts…
            </p>
          ) : shown.length === 0 ? (
            <p className="mt-4 border border-dashed border-[var(--line)] p-5 text-xs text-[var(--ink-2)]">
              {actorId === null
                ? "Sign in before connecting an app."
                : query
                  ? "No app accounts match this search."
                  : "No owned app accounts confirmed. Browse verified sign-in paths below; API-key-only apps require operator configuration."}
            </p>
          ) : (
            <ul className="mt-4 grid gap-2">
              {shown.map((connection) => (
                <li
                  key={connection.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-[var(--line)] p-4"
                >
                  <div className="min-w-0">
                    <h4 className="break-words text-sm font-semibold">{connection.providerKey}</h4>
                    <p className="mt-1 break-words text-xs text-[var(--ink-2)]">
                      {connection.identityLabel || "Owned app account"} · {connection.connectionState === "reauth_required" ? "Sign-in expired" : connection.connectionState === "unavailable" ? "Authorization unavailable" : "Account configured"} · Live action unverified
                    </p>
                    {connection.unavailableReason && <p className="mt-1 text-xs text-[var(--ink-2)]">{connection.unavailableReason}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {connection.connectionState !== undefined && connection.connectionState !== "active" && connection.reconnectSupported !== false && (
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={Boolean(busy) || Boolean(oauth.connectingKey)}
                        onClick={() => {
                          setNotice(null);
                          setError(null);
                          void oauth.beginConnect(reconnectItem(connection), { reconnect: true });
                        }}
                      >
                        Reconnect {connection.providerKey}
                      </button>
                    )}
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={Boolean(busy) || Boolean(oauth.connectingKey)}
                      onClick={() => {
                        void disconnect(connection);
                      }}
                    >
                      Disconnect {connection.providerKey}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {actorId !== null && (
        <div className="flex flex-col gap-6 p-4 lg:p-8">
          <div className="mx-auto w-full max-w-6xl">
            <CuratedMcpConnections onChanged={onChanged} />
          </div>
          <IntegrationCatalogDirectory
            bindingInputs={bindingInputs}
            actorId={actorId}
            connectionRevision={connectionRevision}
            onRequestConnect={(item) => {
              setNotice(null);
              setError(null);
              void oauth.beginConnect(item);
            }}
            connectingKey={oauth.connectingKey}
          />
        </div>
      )}
      <IntegrationsBrowseCatalogDialog
        open={browseOpen}
        actorId={actorId}
        onClose={() => setBrowseOpen(false)}
        onConnect={(item) => {
          setNotice(null);
          setError(null);
          void oauth.beginConnect(item);
        }}
        connectingKey={oauth.connectingKey}
      />
    </div>
  );
}
