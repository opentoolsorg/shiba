import { type JSX, useCallback, useEffect, useState } from "react";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";
import { SkeletonLines } from "../surface";

interface WorkspaceFact {
  id: string;
  team_id: string;
  connection_id: string;
  fact: string;
  created_by: string;
  source_channel: string;
  created_at: number;
}

const ENDPOINT = "/api/admin/workspace-facts";
const forbidden = "Workspace facts require a deployment admin operator. Workspace membership alone does not grant access (403).";

export function WorkspaceFactsSettings(): JSX.Element {
  const [facts, setFacts] = useState<WorkspaceFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(ENDPOINT);
      if (!response.ok) throw new Error(response.status === 403 ? forbidden : `Workspace facts request failed: ${response.status}`);
      const body = await response.json() as { facts?: WorkspaceFact[] };
      setFacts(body.facts ?? []);
    } catch (err) {
      setFacts([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function remove(fact: WorkspaceFact): Promise<void> {
    if (!window.confirm(`Delete this workspace fact?\n\n${fact.fact}`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${ENDPOINT}/${encodeURIComponent(fact.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(response.status === 403 ? forbidden : `Delete failed: ${response.status}`);
      await load();
    } catch (err) {
      setFacts([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  if (loading) return <SkeletonLines rows={4} />;
  if (error) return <LoadErrorState message={error} onRetry={() => void load()} />;

  const groups = new Map<string, WorkspaceFact[]>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.team_id, fact.connection_id]);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--muted-foreground-2)]">
        Employees save shared notes with <code>channel_remember</code> from Slack channels.
        Facts are kept if Slack is disconnected. Only deployment admin operators can manage this list.
      </p>
      {facts.length === 0 ? <Card><p className="px-4 py-6 text-sm text-[var(--muted-foreground-2)]">No workspace facts saved yet.</p></Card> : null}
      {[...groups.entries()].map(([key, rows]) => (
        <section key={key} aria-label={`Slack workspace ${rows[0]!.team_id}, connection ${rows[0]!.connection_id}`}>
          <Card>
            <h4 className="border-b border-[var(--border-1)] px-4 py-3 text-xs font-mono break-all">
              Slack workspace {rows[0]!.team_id} · Connection {rows[0]!.connection_id}
            </h4>
            <ul className="divide-y divide-[var(--border-1)]">
              {rows.map((fact) => (
                <li key={fact.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="whitespace-pre-wrap break-words text-sm">{fact.fact}</p>
                    <p className="text-xs font-mono text-[var(--muted-foreground-2)] break-all">
                      {fact.id} · Saved by {fact.created_by} · Channel {fact.source_channel} · {new Date(fact.created_at).toLocaleString()}
                    </p>
                  </div>
                  <button type="button" aria-label={`Delete fact ${fact.id}`} disabled={busy} onClick={() => void remove(fact)}
                    className="border border-[var(--border-1)] px-3 py-2 text-xs font-mono text-[var(--destructive)] hover:bg-[var(--bg)] disabled:opacity-50">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}
