import { useEffect, useState, type JSX } from "react";
import { Card } from "../settings-ui";

type Subscription = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
};

type Delivery = {
  id: string;
  event: string;
  attempt: number;
  status: string;
  responseCode: number | null;
  nextAttemptAt: number | null;
};

export function WebhooksSettingsPanel(): JSX.Element {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["run.completed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSubs = async () => {
    const response = await fetch("/api/webhooks/subscriptions");
    if (!response.ok) throw new Error(`Webhooks list failed: ${response.status}`);
    const body = (await response.json()) as { subscriptions?: Subscription[] };
    setSubs(body.subscriptions ?? []);
  };

  useEffect(() => {
    void loadSubs().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadDeliveries = async (id: string) => {
    const response = await fetch(`/api/webhooks/subscriptions/${encodeURIComponent(id)}/deliveries`);
    if (!response.ok) throw new Error(`Deliveries failed: ${response.status}`);
    const body = (await response.json()) as { deliveries?: Delivery[] };
    setDeliveries(body.deliveries ?? []);
    setSelected(id);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, events }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Create failed: ${response.status}`);
      }
      const body = (await response.json()) as { secret?: string };
      setSecret(body.secret ?? null);
      setUrl("");
      await loadSubs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const testSend = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/webhooks/subscriptions/${encodeURIComponent(id)}/test`, { method: "POST" });
      if (!response.ok) throw new Error(`Test failed: ${response.status}`);
      await loadDeliveries(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="webhooks-settings" className="space-y-4">
      {error ? (
        <div className="rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)] px-4 py-3 text-xs text-[var(--destructive)] font-mono">
          {error}
        </div>
      ) : null}
      <Card>
        <div className="space-y-3 px-4 py-3">
          <label className="block text-xs font-mono text-[var(--muted-foreground-2)]">
            HTTPS endpoint
            <input
              aria-label="Webhook URL"
              className="mt-1 w-full border border-[var(--border-1)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--fg)]"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hooks/shiba"
            />
          </label>
          <button
            type="button"
            aria-label="Add webhook"
            disabled={busy || !url.trim()}
            onClick={() => void create()}
            className="border border-[var(--border-1)] px-3 py-2 text-xs font-mono"
          >
            Add subscription
          </button>
          {secret ? (
            <p className="text-xs font-mono text-[var(--primary)] break-all">Signing secret (copy now): {secret}</p>
          ) : null}
        </div>
      </Card>
      <Card>
        {subs.length === 0 ? (
          <div className="px-4 py-6 text-xs font-mono text-[var(--muted-foreground-2)]">No webhook subscriptions.</div>
        ) : (
          subs.map((sub) => (
            <div key={sub.id} className="border-b border-[var(--border-1)] px-4 py-3 last:border-b-0">
              <div className="text-sm font-semibold text-[var(--fg)] break-all">{sub.url}</div>
              <div className="text-[11px] font-mono text-[var(--muted-foreground-2)]">{sub.events.join(", ")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="text-[11px] font-mono border border-[var(--border-1)] px-2 py-1" onClick={() => void testSend(sub.id)}>
                  Test send
                </button>
                <button type="button" className="text-[11px] font-mono border border-[var(--border-1)] px-2 py-1" onClick={() => void loadDeliveries(sub.id)}>
                  Deliveries
                </button>
              </div>
            </div>
          ))
        )}
      </Card>
      {selected ? (
        <Card>
          <div className="px-4 py-3 text-xs font-mono text-[var(--muted-foreground-2)]">Deliveries for {selected}</div>
          {deliveries.map((d) => (
            <div key={d.id} className="border-t border-[var(--border-1)] px-4 py-2 text-[11px] font-mono">
              {d.event} · {d.status} · attempt {d.attempt}
              {d.responseCode !== null ? ` · HTTP ${d.responseCode}` : ""}
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}