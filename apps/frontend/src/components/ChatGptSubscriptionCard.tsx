/**
 * Settings → Models — Sign in with ChatGPT (SIWC paste-callback flow).
 */
import { type JSX, useEffect, useState } from "react";
import {
  callbackFieldAfterSuccess,
  completeRequestBody,
  parseSignInBegin,
  parseSubscriptionStatus,
  type SubscriptionStatus,
} from "../chatgpt-subscription-wire";
import { Card } from "./settings-ui";

export function ChatGptSubscriptionCard(): JSX.Element {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [callbackPaste, setCallbackPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const reload = async () => {
    const response = await fetch("/api/subscription/openai");
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `status ${response.status}`);
    }
    setStatus(parseSubscriptionStatus(await response.json()));
  };

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const beginSignIn = async () => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch("/api/subscription/openai/begin", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((body as { error?: string })?.error ?? `begin failed: ${response.status}`);
      }
      const begin = parseSignInBegin(body);
      if (!begin) throw new Error("Invalid begin response.");
      setAuthorizeUrl(begin.authorizeUrl);
      setFeedback("Open the link, sign in, then paste the final 127.0.0.1 callback URL below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const completeSignIn = async () => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch("/api/subscription/openai/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: completeRequestBody(callbackPaste),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        throw new Error((body?.error as string) ?? `complete failed: ${response.status}`);
      }
      setCallbackPaste(callbackFieldAfterSuccess(callbackPaste));
      setAuthorizeUrl(null);
      setStatus(parseSubscriptionStatus(body));
      setFeedback(
        body?.planUsageDisabled
          ? "Signed in, but ChatGPT plan usage was not granted. Re-consent or use an API key."
          : "Connected — ChatGPT plan runs use codex app-server with a short-lived access token only.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch("/api/subscription/openai", { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `disconnect failed: ${response.status}`);
      }
      setStatus({ connected: false });
      setAuthorizeUrl(null);
      setFeedback("Disconnected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="chatgpt-subscription-card">
      <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        ChatGPT subscription (Sign in with ChatGPT)
      </div>
      <div className="space-y-3 px-4 py-4 text-xs text-[var(--muted-foreground-2)]">
        <p>
          Self-hosted OSS: connect your ChatGPT plan via OpenAI token sharing. Shiba stores encrypted tokens on the
          Worker, refreshes them in a per-user Durable Object, and passes only a short-lived <code>ACCESS_TOKEN</code>{" "}
          into your sandbox for <code>codex app-server</code>.
        </p>
        {status?.connected ? (
          <p className="text-[var(--fg)]" data-testid="chatgpt-subscription-connected">
            Connected
            {status.planUsageEnabled === false ? " (plan usage disabled — re-consent)" : ""}
            {status.savedAt ? ` · saved ${new Date(status.savedAt).toLocaleString()}` : ""}.
          </p>
        ) : (
          <p data-testid="chatgpt-subscription-disconnected">Not connected.</p>
        )}
        {authorizeUrl ? (
          <p className="break-all font-mono text-[11px] text-[var(--fg)]">
            <a href={authorizeUrl} data-testid="chatgpt-subscription-authorize-link" target="_blank" rel="noreferrer">
              Open ChatGPT sign-in
            </a>
          </p>
        ) : null}
        <label className="block">
          <span className="mb-1 block font-medium text-[var(--fg)]">Paste callback URL</span>
          <textarea
            data-testid="chatgpt-subscription-callback"
            className="min-h-[80px] w-full rounded border border-[var(--border-1)] bg-[var(--card)] p-2 font-mono text-[11px] text-[var(--fg)]"
            value={callbackPaste}
            onChange={(e) => setCallbackPaste(e.target.value)}
            placeholder="http://127.0.0.1:52841/auth/callback?state=...&code=..."
            disabled={busy}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="chatgpt-subscription-begin"
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void beginSignIn()}
          >
            Start sign-in
          </button>
          <button
            type="button"
            data-testid="chatgpt-subscription-connect"
            className="rounded border border-[var(--border-1)] px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
            disabled={busy || callbackPaste.trim() === ""}
            onClick={() => void completeSignIn()}
          >
            Complete sign-in
          </button>
          {status?.connected ? (
            <button
              type="button"
              data-testid="chatgpt-subscription-disconnect"
              className="rounded border border-[var(--border-1)] px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          ) : null}
        </div>
        {feedback ? <p className="text-[var(--fg)]">{feedback}</p> : null}
        {error ? <p className="text-red-500">{error}</p> : null}
      </div>
    </Card>
  );
}
