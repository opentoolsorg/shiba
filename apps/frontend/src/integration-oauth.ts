import { useCallback, useEffect, useRef, useState } from "react";
import {
  integrationProviderConnectionsResponseSchema,
  type IntegrationProviderCatalogItem,
  type IntegrationProviderConnection,
} from "@shiba/shared";

/** Explain owner authentication separately from provider deployment or an empty catalog. */
export function integrationProviderReadError(status: number, body: unknown, fallback: string): string {
  if (status === 401) {
    return "Sign in to Shiba with a verified user session to load private app accounts and the provider catalog. If this is a local or gateway-only session, the operator must configure user authentication first.";
  }
  if (status === 503) {
    return "OpenConnector is unavailable. Ask the operator to check the sibling service, Shiba's service binding and service credentials, then retry. Reference entries do not confirm provider availability.";
  }
  return body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error
    : fallback;
}

export async function ownedAppConnections(
  signal?: AbortSignal,
  includeUnavailable = false,
): Promise<IntegrationProviderConnection[]> {
  const response = await fetch(`/api/integrations/provider/connections${includeUnavailable ? "?includeUnavailable=1" : ""}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      integrationProviderReadError(response.status, body, `App accounts unavailable (${response.status}).`),
    );
  const parsed = integrationProviderConnectionsResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      "The app account response could not be verified. Refresh before granting access.",
    );
  return parsed.data.connections;
}

export function integrationOAuthTarget(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  )
    throw new Error("Connect returned an unsafe redirect URL.");
  return url.href;
}

/** OAuth completion messages are hints only. Only a fresh owned-account read confirms consent. */
/** Coordinate isolated OAuth popups and verify consent against freshly read owned accounts. */
export function useIntegrationOAuth(options: {
  actorId?: string | null;
  onVerified?: (connection: IntegrationProviderConnection) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const epoch = useRef(0),
    mounted = useRef(true);
  const controller = useRef(new AbortController());
  const pending = useRef<{
    actor: string | null | undefined;
    generation: number;
    providerKey: string;
    popup: Window;
    startedAt: number;
    lastCheck: number;
    checking: boolean;
    closedAt: number | null;
    baselineIds: Set<string>;
    ready: boolean;
    authorizationFingerprint: string | null;
  } | null>(null);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useCallback(
    (item: NonNullable<typeof pending.current>) =>
      mounted.current &&
      pending.current === item &&
      item.generation === epoch.current &&
      item.actor === latest.current.actorId &&
      !controller.current.signal.aborted,
    [],
  );
  const finish = useCallback(
    (item: NonNullable<typeof pending.current>) => {
      if (!current(item)) return;
      pending.current = null;
      setConnectingKey(null);
      item.popup.close();
    },
    [current],
  );
  const reconcile = useRef(async () => {});
  reconcile.current = async () => {
    const item = pending.current;
    if (!item?.ready || !current(item) || item.checking || Date.now() - item.lastCheck < 2_000) return;
    item.lastCheck = Date.now();
    item.checking = true;
    try {
      const connections = await ownedAppConnections(controller.current.signal);
      if (!current(item)) return;
      const matching = connections.filter(
        (connection) => connection.providerKey === item.providerKey && !item.baselineIds.has(connection.id) && connection.authorizationFingerprint === item.authorizationFingerprint,
      );
      const confirmed = matching[0];
      if (matching.length === 1 && confirmed) {
        finish(item);
        setNotice(
          `${item.providerKey} account confirmed. Configure employee permissions separately.`,
        );
        latest.current.onVerified?.(confirmed);
      } else if (matching.length > 1) {
        finish(item);
        setError(
          "Multiple app accounts were reported. Review the account selection before granting access.",
        );
      } else if (
        (item.closedAt !== null && Date.now() - item.closedAt >= 10_000) ||
        Date.now() - item.startedAt >= 5 * 60_000
      ) {
        finish(item);
        setNotice(
          "No connected account was confirmed. Complete sign-in, then refresh accounts. No employee permissions were granted.",
        );
      }
    } catch (cause) {
      if (current(item)) {
        finish(item);
        setError(cause instanceof Error ? cause.message : "App account verification failed.");
      }
    } finally {
      item.checking = false;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Every actor transition must abort and close the previous owner's pending OAuth flow.
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    const focus = () => {
      void reconcile.current();
    };
    const timer = setInterval(() => {
      const item = pending.current;
      if (!item) return;
      if (item.popup.closed) item.closedAt ??= Date.now();
      if (item.closedAt !== null || Date.now() - item.startedAt >= 5 * 60_000)
        void reconcile.current();
    }, 1_000);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      epoch.current++;
      controller.current.abort();
      pending.current?.popup.close();
      pending.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [options.actorId]);
  /** Start OAuth while preventing an existing active account from confirming new consent. */
  const beginConnect = useCallback(
    async (item: IntegrationProviderCatalogItem, options: { reconnect?: boolean } = {}) => {
      if (pending.current || latest.current.actorId === null) return;
      if (!item.connectable) {
        setError(
          "This app has no verified sign-in path. Review its OpenConnector setup with the operator.",
        );
        return;
      }
      // This must happen in the click stack, before the first await, to avoid popup blockers.
      const popup = window.open("about:blank", "_blank", "width=520,height=720");
      if (!popup) {
        setError("Popup blocked. Allow popups for Shiba, then try connecting again.");
        return;
      }
      try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error("Popup isolation unavailable");
      } catch {
        popup.close();
        setError("The sign-in window could not be isolated. Allow a new popup and retry.");
        return;
      }
      const request = {
        actor: latest.current.actorId,
        generation: ++epoch.current,
        providerKey: item.providerKey,
        popup,
        startedAt: Date.now(),
        lastCheck: -Infinity,
        checking: false,
        closedAt: null,
        baselineIds: new Set<string>(),
        ready: false,
        authorizationFingerprint: null as string | null,
      };
      pending.current = request;
      setConnectingKey(item.providerKey);
      setError(null);
      setNotice(null);
      try {
        const baseline = await ownedAppConnections(controller.current.signal, true);
        if (!current(request)) { popup.close(); return; }
        const owned = baseline.filter((connection) => connection.providerKey === item.providerKey);
        request.baselineIds = new Set(owned.map((connection) => connection.id));
        // Reconnect replaces only unusable rows; the old IDs stay in the baseline so they cannot confirm new consent.
        if (owned.length && (!options.reconnect || owned.some((connection) => connection.connectionState === "active")))
          throw new Error(options.reconnect ? "This account is still active. Disconnect it explicitly before signing in again." : "Disconnect the existing owned account before starting a new sign-in. An old account cannot confirm new consent.");
        const response = await fetch("/api/integrations/provider/connect", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.current.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerKey: item.providerKey, ...(options.reconnect ? { replaceUnavailable: true } : {}) }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          redirectUrl?: string;
          authorizationFingerprint?: string;
          error?: string;
        };
        if (!current(request)) {
          popup.close();
          return;
        }
        if (!response.ok || !body.ok || !body.redirectUrl)
          throw new Error(body.error ?? "Connect unavailable.");
        if (!body.authorizationFingerprint || !/^[a-f0-9]{64}$/.test(body.authorizationFingerprint)) throw new Error("The new sign-in consent could not be bound to this request. No account was confirmed.");
        request.authorizationFingerprint = body.authorizationFingerprint;
        popup.location.replace(integrationOAuthTarget(body.redirectUrl));
        request.ready = true;
        setNotice(
          "Complete sign-in in the new window, then return to Shiba. The account is confirmed through a fresh server read.",
        );
      } catch (cause) {
        if (current(request)) {
          finish(request);
          setError(cause instanceof Error ? cause.message : "Connect unavailable.");
        } else popup.close();
      }
    },
    [current, finish],
  );
  return { beginConnect, connectingKey, error, notice };
}
