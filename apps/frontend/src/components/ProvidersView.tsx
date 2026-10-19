/**
 * Providers — ACP adapters that run inside the sandbox (Claude Code,
 * Codex, Gemini CLI, Grok, OpenCode).
 *
 * The previous page called `/api/auth/<provider>-subscription`, which
 * 404s unless that provider's SHIBA_* flag is on, and `/api/agents`,
 * which is a CLI catalog with no connect verbs. This view talks only
 * to `/api/providers`.
 */
import type { AcpProviderCard, AcpProviderConnection, AcpProvidersSnapshot } from "@shiba/shared";
import { type JSX, useCallback, useEffect, useState } from "react";
import type { SetupStatus } from "../live-status";
import { ConnectionsCard } from "./ModelRoutingSection";
import { chip } from "./SubscriptionConnect";

export function gatewayCredentialState(
  gateway: SetupStatus["gateway"] | undefined,
): { tone: "ok" | "warning" | "neutral"; label: string; hint: string | null } {
  if (gateway === undefined || gateway.reachable === "unknown") {
    return { tone: "neutral", label: "AI Gateway", hint: null };
  }
  if (gateway.reachable === "yes") {
    return { tone: "ok", label: "Ready", hint: null };
  }
  if (gateway.reachable === "unauthorized") {
    return {
      tone: "warning",
      label: "Gateway unauthorized",
      hint: gateway.token
        ? "AI_GATEWAY_TOKEN was rejected by the gateway — rotate it."
        : "Set AI_GATEWAY_TOKEN: npx wrangler secret put AI_GATEWAY_TOKEN",
    };
  }
  return {
    tone: "warning",
    label: "Gateway error",
    hint: "The AI Gateway probe failed — check GATEWAY_ID.",
  };
}

export function providerPhaseLabel(connection: Pick<AcpProviderConnection, "phase" | "testOk">): {
  tone: "ok" | "danger" | "pending" | "navy" | "neutral";
  label: string;
} {
  switch (connection.phase) {
    case "connected":
      if (connection.testOk === true) return { tone: "ok", label: "Ready" };
      if (connection.testOk === false) return { tone: "danger", label: "Test failed" };
      return { tone: "ok", label: "Connected" };
    case "waiting":
      return { tone: "pending", label: "Sign-in pending" };
    case "failed":
      return { tone: "danger", label: "Connection failed" };
    default:
      return { tone: "neutral", label: "Not connected" };
  }
}

const PRIMARY =
  "bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-white font-semibold py-1 px-3 rounded-[var(--radius-button)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-mono shadow-[var(--sh-card)] active:translate-y-px";
const SECONDARY =
  "text-[11px] font-mono font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] border border-[var(--border-1)] hover:border-[var(--border-2)] bg-[var(--card)] px-2.5 py-1 rounded-[var(--radius-button)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

function CapabilityList({ card }: { card: AcpProviderCard }): JSX.Element {
  const caps = [
    card.capabilities.acp ? "ACP" : "CLI",
    card.capabilities.streamsText ? "streaming" : null,
    card.capabilities.toolCalls ? "tools" : null,
    card.capabilities.permissions ? "permissions" : null,
    card.capabilities.setModel ? "set model" : null,
    card.capabilities.oauth ? "OAuth" : null,
    card.capabilities.apiKey ? "API key" : null,
  ].filter((item): item is string => item !== null);
  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {caps.map((cap) => (
        <span
          key={cap}
          className="rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground-2)]"
        >
          {cap}
        </span>
      ))}
    </div>
  );
}

export function ProvidersBoard({
  snapshot,
  loading,
  error,
  busyId,
  actionError,
  onRetry,
  onConnectOauth,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  snapshot: AcpProvidersSnapshot | null;
  loading: boolean;
  error: string | null;
  busyId: string | null;
  actionError: string | null;
  onRetry: () => void;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
  onVerify: (id: string) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  return (
    <div data-testid="providers-page" className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--primary)]/20 bg-[var(--primary-soft)] px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--primary)]">
            AI Agent Providers
          </div>
          <h2 className="text-xl font-bold text-[var(--fg)]">Connect your agents</h2>
          <p className="mt-1 max-w-2xl font-mono text-xs leading-relaxed text-[var(--muted-foreground-2)]">
            Each provider is an agent adapter that runs inside the sandbox. Claude Code and Codex
            sign in through the subscription probe. Every provider can fall back to a Worker secret
            or AI Gateway credential. Keys are never pasted here.
          </p>
          {snapshot?.defaultProviderId ? (
            <p className="mt-2 font-mono text-[11px] text-[var(--primary)]" data-testid="providers-org-default">
              Org default: {snapshot.providers.find((provider) => provider.id === snapshot.defaultProviderId)?.label ?? snapshot.defaultProviderId}
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 font-mono text-xs text-[var(--destructive)]">
            <p>{error}</p>
            <button type="button" onClick={onRetry} className={`${SECONDARY} mt-2`}>
              Retry
            </button>
          </div>
        ) : null}
        {actionError ? (
          <div
            data-testid="providers-action-error"
            className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 font-mono text-xs text-[var(--destructive)]"
          >
            {actionError}
          </div>
        ) : null}

        <div>
          <div className="mb-3">
            <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              ACP adapters
            </h3>
            <p className="mt-0.5 font-mono text-xs text-[var(--muted-foreground-2)]">
              Connect, check status, test, disconnect, and pick the org default.
            </p>
          </div>
          {loading && snapshot === null ? (
            <div className="font-mono text-xs text-[var(--muted-foreground-2)]" data-testid="providers-loading">
              Loading providers…
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(snapshot?.providers ?? []).map((card) => (
                <ProviderCard
                  key={card.id}
                  card={card}
                  busy={busyId === card.id}
                  onConnectOauth={onConnectOauth}
                  onConnectApiKey={onConnectApiKey}
                  onVerify={onVerify}
                  onTest={onTest}
                  onDisconnect={onDisconnect}
                  onDefault={onDefault}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-3">
            <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
              Model connections
            </h3>
            <p className="mt-0.5 font-mono text-xs text-[var(--muted-foreground-2)]">
              Named credentials a run can route through.
            </p>
          </div>
          <ConnectionsCard />
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  card,
  busy,
  onConnectOauth,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  card: AcpProviderCard;
  busy: boolean;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
  onVerify: (id: string) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const phase = providerPhaseLabel(card.connection);
  const connected = card.connection.phase === "connected";
  const waiting = card.connection.phase === "waiting";
  return (
    <div
      data-testid={`provider-card-${card.id}`}
      className="rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] p-4 transition-colors hover:border-[var(--border-2)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--fg)]">{card.label}</span>
            {card.isDefault ? (
              <span className="rounded-[var(--radius-button)] border border-[var(--primary)]/30 bg-[var(--primary-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--primary)]">
                Org default
              </span>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--muted-foreground-2)]">{card.blurb}</div>
        </div>
        <span data-testid={`provider-status-${card.id}`}>{chip(phase.tone, phase.label)}</span>
      </div>

      <dl className="mt-3 space-y-1.5 text-[12px]">
        <div className="flex items-baseline gap-2">
          <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Adapter</dt>
          <dd className="truncate font-mono text-[var(--muted-foreground-2)]">{card.adapter}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Harness</dt>
          <dd className="truncate font-mono text-[var(--muted-foreground-2)]">{card.harness}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-20 shrink-0 text-[var(--muted-foreground-2)]">Model</dt>
          <dd className="truncate font-mono text-[var(--muted-foreground-2)]">{card.defaultModel}</dd>
        </div>
      </dl>
      <CapabilityList card={card} />

      {card.connection.message ? (
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">{card.connection.message}</p>
      ) : null}

      {waiting && card.connection.userCode ? (
        <div className="mt-3 space-y-2 border-t border-[var(--border-1)] pt-3">
          <p className="font-mono text-[11px] text-[var(--fg)]">
            Confirmation code{" "}
            <span data-testid={`provider-user-code-${card.id}`} className="font-semibold">
              {card.connection.userCode}
            </span>
          </p>
          {card.connection.verificationUri ? (
            <a
              href={card.connection.verificationUri}
              target="_blank"
              rel="noreferrer"
              className={`${PRIMARY} inline-flex`}
            >
              Open sign-in
            </a>
          ) : null}
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => onVerify(card.id)} className={PRIMARY}>
              {busy ? "Checking…" : "Finish sign-in"}
            </button>
            <button type="button" disabled={busy} onClick={() => onDisconnect(card.id)} className={SECONDARY}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-1)] pt-3">
          {!connected && card.capabilities.oauth ? (
            <button
              type="button"
              data-testid={`provider-connect-oauth-${card.id}`}
              disabled={busy}
              onClick={() => onConnectOauth(card.id)}
              className={PRIMARY}
            >
              {busy ? "Working…" : "Connect with sign-in"}
            </button>
          ) : null}
          {!connected && card.capabilities.apiKey ? (
            <button
              type="button"
              data-testid={`provider-connect-key-${card.id}`}
              disabled={busy}
              onClick={() => onConnectApiKey(card.id)}
              className={SECONDARY}
            >
              Use API credential
            </button>
          ) : null}
          {connected ? (
            <>
              <button type="button" data-testid={`provider-test-${card.id}`} disabled={busy} onClick={() => onTest(card.id)} className={PRIMARY}>
                {busy ? "Testing…" : "Test connection"}
              </button>
              {!card.isDefault ? (
                <button type="button" data-testid={`provider-default-${card.id}`} disabled={busy} onClick={() => onDefault(card.id)} className={SECONDARY}>
                  Set as org default
                </button>
              ) : null}
              <button type="button" data-testid={`provider-disconnect-${card.id}`} disabled={busy} onClick={() => onDisconnect(card.id)} className={SECONDARY}>
                Disconnect
              </button>
            </>
          ) : null}
          <a
            href={card.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[11px] text-[var(--primary)]/80 transition-colors hover:text-[var(--primary)]"
          >
            Docs
          </a>
        </div>
      )}
    </div>
  );
}

async function postProvider(path: string, body: Record<string, unknown>): Promise<AcpProvidersSnapshot> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as AcpProvidersSnapshot & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  if (!Array.isArray(payload.providers)) {
    throw new Error("Provider status was not returned.");
  }
  return payload;
}

export function ProvidersView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AcpProvidersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const reload = attempt;
    void fetch("/api/providers", { cache: reload === 0 ? "default" : "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Providers request failed: ${response.status}`);
        const body = (await response.json()) as AcpProvidersSnapshot;
        if (!cancelled) {
          setSnapshot(body);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const run = useCallback(async (id: string, work: () => Promise<AcpProvidersSnapshot>) => {
    setBusyId(id);
    setActionError(null);
    try {
      setSnapshot(await work());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, []);

  const codeFor = (id: string) => snapshot?.providers.find((provider) => provider.id === id)?.connection.userCode ?? "";

  return (
    <ProvidersBoard
      snapshot={snapshot}
      loading={loading}
      error={error}
      busyId={busyId}
      actionError={actionError}
      onRetry={() => setAttempt((n) => n + 1)}
      onConnectOauth={(id) => void run(id, () => postProvider(`/api/providers/${id}/connect`, { mode: "oauth" }))}
      onConnectApiKey={(id) => void run(id, () => postProvider(`/api/providers/${id}/connect`, { mode: "api-key" }))}
      onVerify={(id) => void run(id, () => postProvider(`/api/providers/${id}/verify`, { userCode: codeFor(id) }))}
      onTest={(id) => void run(id, () => postProvider(`/api/providers/${id}/test`, {}))}
      onDisconnect={(id) => void run(id, () => postProvider(`/api/providers/${id}/disconnect`, {}))}
      onDefault={(id) => void run(id, () => postProvider(`/api/providers/${id}/default`, {}))}
    />
  );
}
