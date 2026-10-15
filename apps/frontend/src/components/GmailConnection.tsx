import { type JSX, useEffect, useRef, useState } from "react";
import { type ChipTone, ToneChip } from "./ToneChip";

type GmailStatus = {
  configured: boolean;
  pending: boolean;
  connection: { id: string; email: string; createdAt: number } | null;
  grants: { principal: string; createdAt: number }[];
};

type DisconnectResult = {
  disconnected: boolean;
  revoke: "revoked" | "failed" | "not_connected";
};

const API = "/api/connections/gmail";
const POLL_MS = 3000;
// Matches the server's consent window; polling stops earlier once status settles.
const POLL_LIMIT_MS = 10 * 60_000;
const REVOKE_FAILED =
  "Local access removed. Google did not confirm revocation — remove this app at myaccount.google.com/permissions.";
const LIMITS = [
  "read-only (gmail.readonly; Shiba cannot send, delete, or modify mail)",
  "only agents you explicitly authorize can search/read",
  "≤25 messages per call, text bodies capped at 20 KiB, no attachments",
  "mail content treated as untrusted",
  "Disconnect removes local access and asks Google to revoke",
];
const BUTTON =
  "rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] transition-colors hover:border-[var(--primary)]/40 hover:bg-[var(--primary)]/5 disabled:cursor-not-allowed disabled:opacity-50";

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(signal: AbortSignal, path = "", init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    signal,
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  signal.throwIfAborted();
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body?.error === "string" ? body.error : `Gmail request failed (${response.status}).`,
    );
  }
  if (body === null) throw new ApiError(response.status, "Gmail returned an invalid response.");
  return body as T;
}

export function GmailConnection(): JSX.Element {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The server's 401 message; null while signed in.
  const [signIn, setSignIn] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(true);
  const pollTimer = useRef<number | null>(null);
  const pollGen = useRef(0);

  function stopPoll() {
    pollGen.current += 1;
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function apply(next: GmailStatus) {
    setStatus(next);
    setSignIn(null);
    if (!next.pending) {
      setAuthUrl(null);
      stopPoll();
    }
  }

  function noteFailure(err: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    if (err instanceof ApiError && err.status === 401) {
      setSignIn(err.message);
      setStatus(null);
      setError(null);
      setAuthUrl(null);
      stopPoll();
      return;
    }
    setError(err instanceof Error ? err.message : "Gmail request failed.");
  }

  // Consent finishes in another tab and nothing posts back, so poll while the server says pending.
  function startPoll(signal: AbortSignal) {
    stopPoll();
    const gen = pollGen.current;
    const deadline = Date.now() + POLL_LIMIT_MS;
    const tick = async () => {
      pollTimer.current = null;
      if (gen !== pollGen.current || signal.aborted || Date.now() > deadline) return;
      if (!locked.current) {
        try {
          const next = await request<GmailStatus>(signal);
          if (gen !== pollGen.current || signal.aborted) return;
          apply(next);
          if (!next.pending) return;
        } catch (err) {
          if (gen !== pollGen.current || signal.aborted) return;
          if (err instanceof ApiError && err.status === 401) {
            noteFailure(err, signal);
            return;
          }
        }
      }
      if (gen === pollGen.current && !signal.aborted) pollTimer.current = window.setTimeout(() => void tick(), POLL_MS);
    };
    pollTimer.current = window.setTimeout(() => void tick(), POLL_MS);
  }

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    locked.current = true;
    setBusy("loading");
    request<GmailStatus>(abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        apply(next);
        if (next.pending) startPoll(abort.signal);
      })
      .catch((err: unknown) => noteFailure(err, abort.signal))
      .finally(() => {
        if (!abort.signal.aborted) {
          locked.current = false;
          setBusy(null);
        }
      });
    return () => {
      abort.abort();
      stopPoll();
    };
  }, []);

  const connected = signIn ? null : (status?.connection ?? null);
  // The agent token never outlives the connected view (disconnect, sign-out).
  useEffect(() => {
    if (!connected) setToken("");
  }, [connected]);

  async function run(action: string, work: (signal: AbortSignal) => Promise<void>) {
    const signal = controller.current?.signal;
    if (locked.current || !signal || signal.aborted) return;
    locked.current = true;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await work(signal);
    } catch (err) {
      noteFailure(err, signal);
    } finally {
      if (!signal.aborted) {
        locked.current = false;
        setBusy(null);
      }
    }
  }

  // Best-effort re-read after a mutation; its failure must not hide the mutation's result.
  async function reload(signal: AbortSignal) {
    const next = await request<GmailStatus>(signal).catch(() => null);
    if (next && !signal.aborted) {
      apply(next);
      if (next.pending) startPoll(signal);
    }
  }

  const refresh = () =>
    void run("refresh", async (signal) => {
      const next = await request<GmailStatus>(signal);
      apply(next);
      if (next.pending) startPoll(signal);
    });

  const connect = () =>
    void run("connect", async (signal) => {
      try {
        const result = await request<{ authorizationUrl: string }>(signal, "/connect", { method: "POST" });
        setAuthUrl(result.authorizationUrl);
        // An open after an await may be popup-blocked; the pending link is the fallback.
        window.open(result.authorizationUrl, "_blank", "noopener");
      } finally {
        // Also after a 409: show what the server actually has.
        await reload(signal);
      }
    });

  const disconnect = (action: "disconnect" | "cancel") =>
    void run(action, async (signal) => {
      stopPoll();
      const result = await request<DisconnectResult>(signal, "", { method: "DELETE" });
      setAuthUrl(null);
      setStatus((current) => current && { ...current, pending: false, connection: null, grants: [] });
      setNotice(
        result.revoke === "failed"
          ? REVOKE_FAILED
          : action === "cancel"
            ? "Authorization cancelled."
            : "Gmail disconnected.",
      );
      await reload(signal);
    });

  const revoke = (principal: string) =>
    void run(`revoke:${principal}`, async (signal) => {
      await request(signal, `/grants/${encodeURIComponent(principal)}`, { method: "DELETE" });
      setStatus((current) => current && { ...current, grants: current.grants.filter((g) => g.principal !== principal) });
      setNotice(`Gmail access revoked for ${principal}.`);
      await reload(signal);
    });

  const pending = !signIn && !connected && Boolean(status?.pending);
  // Re-minted tokens can leave several rows per agent; revoke works per agent, so show one.
  const grants = status ? [...new Map(status.grants.map((grant) => [grant.principal, grant])).values()] : [];
  const label =
    busy === "loading"
      ? "Checking…"
      : signIn
        ? "Sign-in required"
        : connected
          ? "Connected · read-only"
          : pending
            ? "Pending"
            : status
              ? status.configured
                ? "Not connected"
                : "Not configured"
              : "Status error";
  const tone: ChipTone = connected
    ? "ok"
    : signIn || pending
      ? "pending"
      : busy === "loading" || (status !== null && error === null)
        ? "neutral"
        : "danger";

  return (
    <section aria-label="Gmail connection" aria-busy={busy !== null} className="border-b border-[var(--border-1)] px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--fg)]">Gmail</h3>
          <ToneChip tone={tone} label={label} />
        </div>
        <button type="button" onClick={refresh} disabled={busy !== null} className={BUTTON}>
          {busy === "refresh" ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-[var(--muted-foreground-2)]">
        {LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {signIn ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">Sign in to manage the Gmail connection ({signIn})</p>
      ) : null}
      {status && !status.configured && !signIn ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">
          Not configured. An operator sets GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, and GMAIL_TOKEN_KEY.
        </p>
      ) : null}
      {status?.configured && !connected && !pending && !signIn ? (
        <button type="button" onClick={connect} disabled={busy !== null} className={`${BUTTON} mt-3`}>
          {busy === "connect" ? "Opening Google…" : "Connect Gmail"}
        </button>
      ) : null}
      {pending ? (
        <div className="mt-3 space-y-2 text-xs text-[var(--muted-foreground-2)]">
          <p>Finish Google consent in the other tab, then come back; this status updates on its own.</p>
          <div className="flex flex-wrap items-center gap-2">
            {authUrl ? (
              <a href={authUrl} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                Open Google consent
              </a>
            ) : null}
            <button type="button" onClick={() => disconnect("cancel")} disabled={busy !== null} className={BUTTON}>
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
      {connected ? (
        <div className="mt-3 space-y-3 text-xs text-[var(--muted-foreground-2)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="break-all font-mono text-[var(--fg)]">{connected.email}</p>
            <button type="button" onClick={() => disconnect("disconnect")} disabled={busy !== null} className={BUTTON}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
          <div>
            <h4 className="mb-1 font-semibold text-[var(--fg)]">Active agent grants</h4>
            {grants.length > 0 ? (
              <ul className="space-y-1">
                {grants.map((grant) => (
                  <li key={grant.principal} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono">{grant.principal}</span>
                    <button
                      type="button"
                      aria-label={`Revoke Gmail access for ${grant.principal}`}
                      disabled={busy !== null}
                      className={BUTTON}
                      onClick={() => revoke(grant.principal)}
                    >
                      {busy === `revoke:${grant.principal}` ? "Revoking…" : "Revoke"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No agent is authorized.</p>
            )}
          </div>
          <form
            className="space-y-2 border-t border-[var(--border-1)] pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              const submitted = token.trim();
              if (!submitted) return;
              setToken("");
              void run("grant", async (signal) => {
                // The token lives only in this closure for the POST body.
                const grant = await request<{ principal: string }>(signal, "/grants", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token: submitted }),
                });
                setNotice(`Read-only Gmail access granted to ${grant.principal}.`);
                await reload(signal);
              });
            }}
          >
            <label htmlFor="gmail-agent-token" className="block text-xs font-semibold text-[var(--fg)]">
              Agent token (gmail:read)
            </label>
            <p id="gmail-token-hint" className="text-xs leading-relaxed text-[var(--muted-foreground-2)]">
              Mint one for a dedicated agent name (lowercase letters, digits, - or _):{" "}
              <code className="font-mono">node scripts/mint-token.mjs --agent &lt;name&gt; --scopes gmail:read --write</code>.
              The token is verified and not stored.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                id="gmail-agent-token"
                type="password"
                aria-describedby="gmail-token-hint"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={busy !== null}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                className="min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--secondary)] px-2.5 py-1.5 font-mono text-xs text-[var(--fg)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              />
              <button type="submit" disabled={busy !== null || token.trim() === ""} className={BUTTON}>
                {busy === "grant" ? "Authorizing…" : "Authorize"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {/* Live regions stay mounted so screen readers announce changes reliably. */}
      <p role="alert" className={error ? "mt-3 text-xs text-[var(--destructive)]" : "sr-only"}>
        {error ?? ""}
      </p>
      <p role="status" className={notice ? "mt-3 text-xs leading-relaxed text-[var(--primary)]" : "sr-only"}>
        {notice ?? ""}
      </p>
    </section>
  );
}
