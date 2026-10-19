/**
 * Settings → Models — per-user ChatGPT subscription (paste auth.json).
 */
import { type JSX, useEffect, useState } from "react";
import {
  parseSubscriptionStatus,
  pasteFieldAfterSuccessfulConnect,
  pasteRequestBody,
  type SubscriptionStatus,
} from "../chatgpt-subscription-wire";
import { Card } from "./settings-ui";

type Status = SubscriptionStatus;

export function ChatGptSubscriptionCard(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [paste, setPaste] = useState("");
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

  const connect = async () => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch("/api/subscription/openai/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pasteRequestBody(paste),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const err = body && typeof body.error === "string" ? body.error : `save failed: ${response.status}`;
        throw new Error(err);
      }
      setPaste(pasteFieldAfterSuccessfulConnect(paste));
      setStatus(parseSubscriptionStatus(body));
      setFeedback("Connected — your ChatGPT plan can run on codex-subscription tasks you start.");
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
        ChatGPT subscription
      </div>
      <div className="space-y-3 px-4 py-4 text-xs text-[var(--muted-foreground-2)]">
        <p>
          Run Codex on your ChatGPT plan (self-hosted OSS). On your machine run{" "}
          <code className="text-[var(--fg)]">codex login</code>, then paste the contents of{" "}
          <code className="text-[var(--fg)]">~/.codex/auth.json</code> below. Shiba encrypts it and never shows it back.
        </p>
        {status?.connected ? (
          <p className="text-[var(--fg)]" data-testid="chatgpt-subscription-connected">
            Connected{status.savedAt ? ` (saved ${new Date(status.savedAt).toLocaleString()})` : ""}.
          </p>
        ) : (
          <p data-testid="chatgpt-subscription-disconnected">Not connected.</p>
        )}
        <label className="block">
          <span className="mb-1 block font-medium text-[var(--fg)]">Paste auth.json</span>
          <textarea
            data-testid="chatgpt-subscription-paste"
            className="min-h-[120px] w-full rounded border border-[var(--border-1)] bg-[var(--card)] p-2 font-mono text-[11px] text-[var(--fg)]"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder='{"tokens":{"access_token":"…"}}'
            disabled={busy}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="chatgpt-subscription-connect"
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
            disabled={busy || paste.trim() === ""}
            onClick={() => void connect()}
          >
            Save connection
          </button>
          {status?.connected ? (
            <button
              type="button"
              data-testid="chatgpt-subscription-disconnect"
              className="rounded border border-[var(--border-1)] px-3 py-1.5 text-[11px] font-semibold text-[var(--fg)] disabled:opacity-50"
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
