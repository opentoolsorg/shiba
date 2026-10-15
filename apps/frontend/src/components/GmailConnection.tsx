import { type JSX, useEffect, useRef, useState } from "react";
import { type ChipTone, ToneChip } from "./ToneChip";

type GmailStatus = {
  configured: boolean;
  connection: { id: string; email: string; createdAt: number } | null;
  grants: { principal: string; createdAt: number }[];
};

type DisconnectResult = {
  disconnected: boolean;
  revoke: "revoked" | "failed" | "not_connected";
};

const API = "/api/connections/gmail";
const PENDING_NOTICE = "Finish in the Google tab, then Refresh status";
const REVOKE_FAILED =
  "Local access removed. Google did not confirm revocation — remove Shiba at myaccount.google.com/permissions.";
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

function isSignIn(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
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
    const message =
      response.status === 409 && path === "/connect"
        ? "Gmail is already connected or sign-in is pending."
        : typeof body?.error === "string"
          ? body.error
          : `Gmail request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  if (body === null) throw new ApiError(response.status, "Gmail returned an invalid response.");
  return body as T;
}

export function GmailConnection(): JSX.Element {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
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

  function noteFailure(err: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    if (isSignIn(err)) {
      setSignedOut(true);
      setStatus(null);
      setError(null);
      setPending(false);
      stopPoll();
      return;
    }
    setError(err instanceof Error ? err.message : "Gmail request failed.");
  }

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    locked.current = true;
    setBusy("loading");
    request<GmailStatus>(abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        setStatus(next);
        setSignedOut(false);
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

  // Consent finishes in another tab; nothing posts back, so poll GET for 2 minutes.
  function startPoll(signal: AbortSignal) {
    const gen = ++pollGen.current;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    const deadline = Date.now() + 120_000;
    const tick = async () => {
      pollTimer.current = null;
      if (gen !== pollGen.current || signal.aborted || Date.now() > deadline) {
        if (gen === pollGen.current) setPending(false);
        return;
      }
      if (!locked.current) {
        try {
          const next = await request<GmailStatus>(signal);
          if (gen !== pollGen.current || signal.aborted) return;
          setStatus(next);
          setSignedOut(false);
          setError(null);
          if (next.connection) {
            setPending(false);
            setNotice(null);
            return;
          }
        } catch (err) {
          if (gen !== pollGen.current || signal.aborted) return;
          if (isSignIn(err)) {
            noteFailure(err, signal);
            return;
          }
        }
      }
      if (gen !== pollGen.current || signal.aborted || Date.now() > deadline) {
        if (gen === pollGen.current) setPending(false);
        return;
      }
      pollTimer.current = window.setTimeout(() => void tick(), 3000);
    };
    pollTimer.current = window.setTimeout(() => void tick(), 3000);
  }

  const refresh = () =>
    void run("refresh", async (signal) => {
      const next = await request<GmailStatus>(signal);
      setStatus(next);
      setSignedOut(false);
      if (next.connection) {
        setPending(false);
        stopPoll();
      }
    });

  const connect = () =>
    void run("connect", async (signal) => {
      const result = await request<{ authorizationUrl: string; expiresAt: number }>(signal, "/connect", {
        method: "POST",
      });
      window.open(result.authorizationUrl, "_blank", "noopener");
      setPending(true);
      setNotice(PENDING_NOTICE);
      startPoll(signal);
    });

  const disconnect = () =>
    void run("disconnect", async (signal) => {
      stopPoll();
      setPending(false);
      const result = await request<DisconnectResult>(signal, "", { method: "DELETE" });
      setStatus(await request<GmailStatus>(signal));
      setNotice(result.revoke === "failed" ? REVOKE_FAILED : "Gmail disconnected.");
    });

  const connected = signedOut ? null : status?.connection;
  const label =
    busy === "loading"
      ? "Checking…"
      : signedOut
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
    : signedOut || pending
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
      {signedOut ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">Sign in to manage the Gmail connection.</p>
      ) : null}
      {status && !status.configured && !signedOut ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground-2)]">
          Not configured. An operator sets GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, and GMAIL_TOKEN_KEY.
        </p>
      ) : null}
      {status?.configured && !connected && !pending && !signedOut ? (
        <button type="button" onClick={connect} disabled={busy !== null} className={`${BUTTON} mt-3`}>
          {busy === "connect" ? "Opening Google…" : "Connect Gmail"}
        </button>
      ) : null}
      {connected ? (
        <div className="mt-3 space-y-3 text-xs text-[var(--muted-foreground-2)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="break-all font-mono text-[var(--fg)]">{connected.email}</p>
            <button type="button" onClick={disconnect} disabled={busy !== null} className={BUTTON}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
          <div>
            <h4 className="mb-1 font-semibold text-[var(--fg)]">Active agent grants</h4>
            {status && status.grants.length > 0 ? (
              <ul className="space-y-1">
                {status.grants.map((grant) => (
                  <li key={grant.principal} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono">{grant.principal}</span>
                    <button
                      type="button"
                      aria-label={`Revoke Gmail access for ${grant.principal}`}
                      disabled={busy !== null}
                      className={BUTTON}
                      onClick={() =>
                        void run("revoke", async (signal) => {
                          await request(signal, `/grants/${encodeURIComponent(grant.principal)}`, { method: "DELETE" });
                          setStatus(await request<GmailStatus>(signal));
                          setNotice(`Gmail access revoked for ${grant.principal}.`);
                        })
                      }
                    >
                      {busy === "revoke" ? "Revoking…" : "Revoke"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No agent is authorized.</p>
            )}
          </div>
        </div>
      ) : null}
      {connected ? (
      <form
        className="mt-3 space-y-2 border-t border-[var(--border-1)] pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = token.trim();
          if (!submitted || !connected) return;
          setToken("");
          void run("grant", async (signal) => {
            // Submitted value lives only in this closure for the POST body.
            await request(signal, "/grants", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: submitted }),
            });
            setStatus(await request<GmailStatus>(signal));
            setNotice("Read-only Gmail access granted.");
          });
        }}
      >
        <label htmlFor="gmail-agent-token" className="block text-xs font-semibold text-[var(--fg)]">
          Agent token (gmail:read)
        </label>
        <p id="gmail-token-hint" className="text-xs leading-relaxed text-[var(--muted-foreground-2)]">
          Mint one with{" "}
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
            disabled={!connected || busy !== null}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--secondary)] px-2.5 py-1.5 font-mono text-xs text-[var(--fg)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
          <button type="submit" disabled={!connected || busy !== null || token.trim() === ""} className={BUTTON}>
            {busy === "grant" ? "Authorizing…" : "Authorize"}
          </button>
        </div>
      </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-xs leading-relaxed text-[var(--primary)]">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
