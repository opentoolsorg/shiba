import { useEffect, useState, type JSX } from "react";
import { Card } from "../settings-ui";

type ApiKeyRow = {
  keyId: string;
  tokenPrefix?: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt?: number | null;
  revoked: boolean;
};

export function ApiKeysSettingsPanel(): JSX.Element {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [label, setLabel] = useState("integration");
  const [scopeRead, setScopeRead] = useState(true);
  const [scopeWrite, setScopeWrite] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const response = await fetch("/api/api-keys");
    if (!response.ok) throw new Error(`API keys request failed: ${response.status}`);
    const body = (await response.json()) as { keys?: ApiKeyRow[] };
    setKeys(Array.isArray(body.keys) ? body.keys : []);
  };

  useEffect(() => {
    void reload().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const mint = async () => {
    setBusy(true);
    setError(null);
    const scopes = [...(scopeRead ? ["api:read"] : []), ...(scopeWrite ? ["api:write"] : [])];
    if (scopes.length === 0) {
      setError("Select at least one scope.");
      setBusy(false);
      return;
    }
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, scopes }),
      });
      if (!response.ok) throw new Error(`Mint failed: ${response.status}`);
      const body = (await response.json()) as { token?: string };
      setMintedToken(body.token ?? null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/api-keys?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Revoke failed: ${response.status}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="api-keys-settings" className="space-y-4">
      {error ? (
        <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 text-xs text-[var(--destructive)] font-mono">
          {error}
        </div>
      ) : null}
      <Card>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="text-xs font-mono text-[var(--muted-foreground-2)]">
            Label
            <input
              aria-label="API key label"
              className="mt-1 w-full border border-[var(--border-1)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)]"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-4 text-xs font-mono">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={scopeRead} onChange={(e) => setScopeRead(e.target.checked)} />
              read
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={scopeWrite} onChange={(e) => setScopeWrite(e.target.checked)} />
              write
            </label>
          </div>
          <button
            type="button"
            aria-label="Mint API key"
            disabled={busy || !label.trim()}
            onClick={() => void mint()}
            className="self-start border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs font-mono hover:bg-[var(--bg)] disabled:opacity-50"
          >
            Create key
          </button>
        </div>
        {mintedToken ? (
          <div className="border-t border-[var(--border-1)] px-4 py-3 text-xs font-mono text-[var(--primary)] break-all">
            New key (copy now): {mintedToken}
          </div>
        ) : null}
      </Card>
      <Card>
        {keys.length === 0 ? (
          <div className="px-4 py-6 text-xs font-mono text-[var(--muted-foreground-2)]">No API keys yet.</div>
        ) : (
          keys.map((key) => (
            <div
              key={key.keyId}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] px-4 py-3 last:border-b-0"
            >
              <div>
                <div className="text-sm font-semibold text-[var(--fg)]">{key.label}</div>
                <div className="text-[11px] font-mono text-[var(--muted-foreground-2)]">
                  {key.tokenPrefix ?? key.keyId} · {key.scopes.join(", ")}
                  {key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleString()}` : ""}
                  {key.revoked ? " · revoked" : ""}
                </div>
              </div>
              {!key.revoked ? (
                <button
                  type="button"
                  aria-label={`Revoke ${key.label}`}
                  disabled={busy}
                  onClick={() => void revoke(key.keyId)}
                  className="text-[11px] font-mono border border-[var(--border-1)] px-2 py-1"
                >
                  Revoke
                </button>
              ) : null}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}