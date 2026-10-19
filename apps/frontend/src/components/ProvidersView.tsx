import type { AcpProviderCard, AcpProvidersSnapshot } from "@shiba/shared";
import { type JSX, useCallback, useEffect, useState } from "react";
import { LoadErrorState } from "./LoadErrorState";
import { ConnectionsCard } from "./ModelRoutingSection";
import { providerPhaseLabel } from "./provider-phase";
import { EmptyState, PageHeader, StatusNotice } from "./surface";
import { ToneChip } from "./ToneChip";

const PRIMARY =
  "inline-flex min-h-6 touch:min-h-11 items-center bg-[var(--primary)] text-[var(--primary-text)] font-mono text-[11px] font-semibold px-3 py-1.5 shadow-[var(--sh-card)] active:translate-y-px hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed";
const SECONDARY =
  "inline-flex min-h-6 touch:min-h-11 items-center border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1.5 font-mono text-[11px] font-medium text-[var(--fg)] hover:bg-[var(--secondary)] active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed";

function ProviderSkeleton(): JSX.Element {
  return (
    <div
      className="border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between border-b border-[var(--border-1)] bg-[var(--panel)] px-3 py-2.5">
        <div className="skeleton h-3 w-28" />
        <div className="skeleton h-4 w-16" />
      </div>
      <div className="space-y-2 px-3 py-3">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-2/3" />
        <div className="skeleton mt-3 h-7 w-36" />
      </div>
      <div className="border-t border-[var(--border-1)] px-3 py-2">
        <div className="skeleton h-3 w-40" />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="min-w-0 bg-[var(--card)] px-2.5 py-1.5" title={`${label} ${value}`}>
      <span className="uppercase tracking-[0.12em] text-[var(--muted-foreground-3)]">{label} </span>
      <span className="text-[var(--fg)]">{value}</span>
    </span>
  );
}

function NewTabLabel({ children }: { children: string }): JSX.Element {
  return (
    <>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
}

function WaitingSignIn({
  card,
  busy,
  onVerify,
  onDisconnect,
}: {
  card: AcpProviderCard;
  busy: boolean;
  onVerify: (id: string) => void;
  onDisconnect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mt-3 border border-[var(--border-1)] bg-[var(--panel)] px-3 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
        Confirmation code
      </p>
      <p
        data-testid={`provider-user-code-${card.id}`}
        className="mt-1 font-mono text-lg tracking-[0.18em] text-[var(--fg)]"
      >
        {card.connection.userCode}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.connection.verificationUri ? (
          <a
            href={card.connection.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY}
          >
            <NewTabLabel>Open sign-in</NewTabLabel>
          </a>
        ) : null}
        <button type="button" disabled={busy} onClick={() => onVerify(card.id)} className={PRIMARY}>
          {busy ? "Checking…" : "Finish sign-in"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDisconnect(card.id)}
          className={SECONDARY}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DisconnectedActions({
  card,
  busy,
  onConnectOauth,
  onConnectApiKey,
}: {
  card: AcpProviderCard;
  busy: boolean;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {card.capabilities.oauth ? (
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
      {card.capabilities.apiKey ? (
        <button
          type="button"
          data-testid={`provider-connect-key-${card.id}`}
          disabled={busy}
          onClick={() => onConnectApiKey(card.id)}
          className={card.capabilities.oauth ? SECONDARY : PRIMARY}
        >
          Use API credential
        </button>
      ) : null}
    </div>
  );
}

function ConnectedActions({
  card,
  busy,
  onTest,
  onDisconnect,
  onDefault,
}: {
  card: AcpProviderCard;
  busy: boolean;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={`provider-test-${card.id}`}
        disabled={busy}
        onClick={() => onTest(card.id)}
        className={PRIMARY}
      >
        {busy ? "Testing…" : "Test connection"}
      </button>
      {card.isDefault ? null : (
        <button
          type="button"
          data-testid={`provider-default-${card.id}`}
          disabled={busy}
          onClick={() => onDefault(card.id)}
          className={SECONDARY}
        >
          Set as org default
        </button>
      )}
      <button
        type="button"
        data-testid={`provider-disconnect-${card.id}`}
        disabled={busy}
        onClick={() => onDisconnect(card.id)}
        className={SECONDARY}
      >
        Disconnect
      </button>
    </div>
  );
}

function ProviderActions(props: {
  card: AcpProviderCard;
  busy: boolean;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
  onVerify: (id: string) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const { card } = props;
  if (card.connection.phase === "waiting" && card.connection.userCode) {
    return (
      <WaitingSignIn
        card={card}
        busy={props.busy}
        onVerify={props.onVerify}
        onDisconnect={props.onDisconnect}
      />
    );
  }
  if (card.connection.phase === "connected") {
    return (
      <ConnectedActions
        card={card}
        busy={props.busy}
        onTest={props.onTest}
        onDisconnect={props.onDisconnect}
        onDefault={props.onDefault}
      />
    );
  }
  return (
    <DisconnectedActions
      card={card}
      busy={props.busy}
      onConnectOauth={props.onConnectOauth}
      onConnectApiKey={props.onConnectApiKey}
    />
  );
}

function ProviderCard({
  card,
  index,
  busy,
  onConnectOauth,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  card: AcpProviderCard;
  index: number;
  busy: boolean;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
  onVerify: (id: string) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const phase = providerPhaseLabel(card.connection);
  const ordinal = String(index + 1).padStart(2, "0");
  return (
    <article
      data-testid={`provider-card-${card.id}`}
      aria-busy={busy}
      className="flex min-w-0 flex-col border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-[var(--muted-foreground-3)]">
            {ordinal}
          </span>
          <h4 className="truncate text-[13px] font-semibold text-[var(--fg)]">{card.label}</h4>
          {card.isDefault ? (
            <span className="shrink-0 border border-[var(--primary)]/30 bg-[var(--primary-soft)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--primary)]">
              Default
            </span>
          ) : null}
        </div>
        <span data-testid={`provider-status-${card.id}`} className="shrink-0">
          <ToneChip tone={phase.tone} label={phase.label} />
        </span>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground-2)]">{card.blurb}</p>
        {card.connection.message ? (
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-[var(--fg)]">
            {card.connection.message}
          </p>
        ) : null}
        <ProviderActions
          card={card}
          busy={busy}
          onConnectOauth={onConnectOauth}
          onConnectApiKey={onConnectApiKey}
          onVerify={onVerify}
          onTest={onTest}
          onDisconnect={onDisconnect}
          onDefault={onDefault}
        />
      </div>

      <footer className="mt-auto flex min-w-0 flex-wrap gap-px border-t border-[var(--border-1)] bg-[var(--border-1)] font-mono text-[10px] text-[var(--muted-foreground-2)]">
        <Fact label="Lane" value={card.capabilities.acp ? "ACP" : "CLI"} />
        <Fact label="Harness" value={card.harness} />
        <Fact label="Model" value={card.defaultModel} />
        <a
          href={card.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex min-h-6 touch:min-h-11 items-center bg-[var(--card)] px-2.5 py-1.5 uppercase tracking-[0.12em] text-[var(--primary)] hover:bg-[var(--panel)]"
        >
          <NewTabLabel>Docs</NewTabLabel>
        </a>
      </footer>
    </article>
  );
}

async function postProvider(
  path: string,
  body: Record<string, unknown>,
): Promise<AcpProvidersSnapshot> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  const payload = (await response.json()) as AcpProvidersSnapshot;
  if (!Array.isArray(payload.providers)) {
    throw new Error("Provider status was not returned.");
  }
  return payload;
}

function AdapterBody({
  snapshot,
  loading,
  busyId,
  onConnectOauth,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  snapshot: AcpProvidersSnapshot | null;
  loading: boolean;
  busyId: string | null;
  onConnectOauth: (id: string) => void;
  onConnectApiKey: (id: string) => void;
  onVerify: (id: string) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  if (loading && snapshot === null) {
    return (
      <div data-testid="providers-loading" role="status" className="flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          Loading providers…
        </p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {["a", "b", "c", "d"].map((key) => (
            <ProviderSkeleton key={key} />
          ))}
        </div>
      </div>
    );
  }
  const providers = snapshot?.providers ?? [];
  if (providers.length === 0) {
    return (
      <EmptyState title="No adapters" detail="The registry returned no sandbox adapters." />
    );
  }
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {providers.map((card, index) => (
        <ProviderCard
          key={card.id}
          card={card}
          index={index}
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
  const ready =
    snapshot?.providers.filter((provider) => provider.connection.phase === "connected").length ?? 0;
  const total = snapshot?.providers.length ?? 0;
  const defaultLabel = snapshot?.defaultProviderId
    ? (snapshot.providers.find((provider) => provider.id === snapshot.defaultProviderId)?.label ??
      snapshot.defaultProviderId)
    : null;

  return (
    <div
      data-testid="providers-page"
      className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]"
    >
      <PageHeader
        title="Providers"
        detail="Sandbox adapters for Claude Code, Codex, Gemini, Grok, and OpenCode. Sign in, or use a worker secret. Keys are never pasted here."
      >
        {defaultLabel ? (
          <span
            data-testid="providers-org-default"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]"
          >
            Org default · {defaultLabel}
          </span>
        ) : null}
        <span className="border border-[var(--border-1)] bg-[var(--card)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          {snapshot ? `${ready} of ${total} connected` : "—"}
        </span>
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8">
          {error ? <LoadErrorState message={error} onRetry={onRetry} /> : null}
          {actionError ? (
            <div data-testid="providers-action-error">
              <StatusNotice tone="err">{actionError}</StatusNotice>
            </div>
          ) : null}

          {error && snapshot === null ? null : (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--border-1)] pb-2">
                <h3 className="text-sm font-semibold text-[var(--fg)]">Sandbox adapters</h3>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                  Org default is recorded here. A run still uses the harness for that task.
                </p>
              </div>
              <AdapterBody
                snapshot={snapshot}
                loading={loading}
                busyId={busyId}
                onConnectOauth={onConnectOauth}
                onConnectApiKey={onConnectApiKey}
                onVerify={onVerify}
                onTest={onTest}
                onDisconnect={onDisconnect}
                onDefault={onDefault}
              />
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--border-1)] pb-2">
              <h3 className="text-sm font-semibold text-[var(--fg)]">Model connections</h3>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Named credentials a run can route through.
              </p>
            </div>
            <ConnectionsCard />
          </section>
        </div>
      </div>
    </div>
  );
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

  const codeFor = (id: string) =>
    snapshot?.providers.find((provider) => provider.id === id)?.connection.userCode ?? "";

  return (
    <ProvidersBoard
      snapshot={snapshot}
      loading={loading}
      error={error}
      busyId={busyId}
      actionError={actionError}
      onRetry={() => setAttempt((n) => n + 1)}
      onConnectOauth={(id) =>
        void run(id, () => postProvider(`/api/providers/${id}/connect`, { mode: "oauth" }))
      }
      onConnectApiKey={(id) =>
        void run(id, () => postProvider(`/api/providers/${id}/connect`, { mode: "api-key" }))
      }
      onVerify={(id) =>
        void run(id, () => postProvider(`/api/providers/${id}/verify`, { userCode: codeFor(id) }))
      }
      onTest={(id) => void run(id, () => postProvider(`/api/providers/${id}/test`, {}))}
      onDisconnect={(id) => void run(id, () => postProvider(`/api/providers/${id}/disconnect`, {}))}
      onDefault={(id) => void run(id, () => postProvider(`/api/providers/${id}/default`, {}))}
    />
  );
}
