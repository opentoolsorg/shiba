import { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationProviderCatalogItem, WorkspaceIntegrationConnection } from "@shiba/shared";
import { integrationOAuthTarget } from "./integration-oauth";
import { beginWorkspaceAppConsent, reconcileWorkspaceAppConsent, workspaceAccessChanged } from "./workspace-integrations-client";

interface PendingWorkspaceConsent {
  workspaceId: string; actorId: string; generation: number; controller: AbortController; popup: Window;
  connection: WorkspaceIntegrationConnection | null; pendingId: string; fingerprint: string;
  startedAt: number; closedAt: number | null; checking: boolean; lastCheck: number;
}

export function useWorkspaceIntegrationOAuth(options: {
  workspaceId: string; actorId?: string | null; canManage: boolean;
  onConfirmed: (connection: WorkspaceIntegrationConnection) => void;
  onAccessLost: () => void;
}) {
  const latest = useRef(options); latest.current = options;
  const generation = useRef(0), controller = useRef(new AbortController()), mounted = useRef(false);
  const pending = useRef<PendingWorkspaceConsent | null>(null);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const current = useCallback((item: PendingWorkspaceConsent) => mounted.current && pending.current === item &&
    item.workspaceId === latest.current.workspaceId && item.actorId === latest.current.actorId && latest.current.canManage &&
    item.generation === generation.current && item.controller === controller.current && !item.controller.signal.aborted, []);
  const finish = useCallback((item: PendingWorkspaceConsent) => {
    if (!current(item)) return;
    pending.current = null; item.popup.close(); setConnectingKey(null);
  }, [current]);
  const reconcile = useRef(async () => {});
  reconcile.current = async () => {
    const item = pending.current;
    if (!item?.connection || !current(item) || item.checking || Date.now() - item.lastCheck < 2_000) return;
    item.checking = true; item.lastCheck = Date.now();
    try {
      const body = await reconcileWorkspaceAppConsent(item.workspaceId, item.connection, item.pendingId, item.fingerprint, item.controller.signal);
      if (!current(item)) return;
      item.connection = body.connection;
      if (body.connection.state === "active" && body.connection.upstreamReady) {
        finish(item);
        setNotice("Workspace sign-in was reported by the integration service. Employee permissions and live action checks are still separate.");
        latest.current.onConfirmed(body.connection);
      } else if (body.connection.state !== "pending") {
        finish(item);
        setError("The shared account is not ready. Review its state before disconnecting or starting fresh consent.");
      } else if ((item.closedAt !== null && Date.now() - item.closedAt > 10_000) || Date.now() - item.startedAt > 5 * 60_000) {
        finish(item); setNotice("Sign-in is not confirmed. Refresh the account state. No employee permissions were granted.");
      }
    } catch (cause) {
      if (current(item)) {
        finish(item);
        if (workspaceAccessChanged(cause)) latest.current.onAccessLost();
        setError(cause instanceof Error ? cause.message : "Workspace consent verification failed.");
      }
    } finally { item.checking = false; }
  };
  useEffect(() => {
    mounted.current = true; const abort = new AbortController(); controller.current = abort;
    setConnectingKey(null); setError(null); setNotice(null);
    const focus = () => { void reconcile.current(); };
    const timer = window.setInterval(() => {
      const item = pending.current;
      if (!item || !current(item)) return;
      if (item.popup.closed) item.closedAt ??= Date.now();
      if (item.closedAt !== null || Date.now() - item.startedAt > 5 * 60_000) void reconcile.current();
    }, 1_000);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false; generation.current++; abort.abort();
      pending.current?.popup.close(); pending.current = null;
      window.clearInterval(timer); window.removeEventListener("focus", focus);
    };
  }, [options.workspaceId, options.actorId, options.canManage, current]);
  const beginConnect = useCallback(async (item: IntegrationProviderCatalogItem) => {
    const scope = latest.current;
    if (!mounted.current || pending.current || !scope.canManage || !scope.actorId || !item.connectable) return;
    const popup = window.open("about:blank", "_blank", "width=520,height=720");
    if (!popup) { setError("Allow a new sign-in window for Shiba, then try again."); return; }
    try { popup.opener = null; if (popup.opener !== null) throw new Error("isolation_unavailable"); }
    catch { popup.close(); setError("The sign-in window could not be isolated. No account was connected."); return; }
    const request: PendingWorkspaceConsent = { workspaceId: scope.workspaceId, actorId: scope.actorId, generation: generation.current, controller: controller.current, popup,
      connection: null, pendingId: "", fingerprint: "", startedAt: Date.now(), closedAt: null, checking: false, lastCheck: 0 };
    pending.current = request; setConnectingKey(item.providerKey); setError(null); setNotice(null);
    try {
      const body = await beginWorkspaceAppConsent(request.workspaceId, item.providerKey, request.controller.signal);
      if (!current(request)) { popup.close(); return; }
      request.connection = body.connection; request.pendingId = body.pendingId; request.fingerprint = body.authorizationFingerprint;
      popup.location.replace(integrationOAuthTarget(body.redirectUrl));
      setNotice("Complete the app sign-in, then return to this workspace. Shiba will verify the exact consent receipt with the server.");
    } catch (cause) {
      if (current(request)) {
        finish(request);
        if (workspaceAccessChanged(cause)) latest.current.onAccessLost();
        setError(cause instanceof Error ? cause.message : "Shared app consent is unavailable.");
      } else popup.close();
    }
  }, [current, finish]);
  return { beginConnect, connectingKey, error, notice };
}
