import { useCallback, useEffect, useState, type JSX } from "react";
import { LoadErrorState } from "../LoadErrorState";
import { StatusNotice } from "../surface";

interface ConnectedAppGrant {
  id: string;
  clientName: string;
  clientId: string;
  kind: "oauth" | "token";
  access: "read" | "write" | "full";
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function ConnectedApps(): JSX.Element {
  const [grants, setGrants] = useState<ConnectedAppGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/mcp/connected-apps", { credentials: "include" });
      const body = await response.json() as { ok?: boolean; grants?: ConnectedAppGrant[]; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "Could not load connected apps.");
        setGrants([]);
        return;
      }
      setGrants(Array.isArray(body.grants) ? body.grants : []);
    } catch {
      setError("Could not load connected apps.");
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (grantId: string) => {
    setBusyId(grantId);
    try {
      const response = await fetch(`/api/v1/mcp/connected-apps/${encodeURIComponent(grantId)}/revoke`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) setError("Revoke failed.");
      else await load();
    } catch {
      setError("Revoke failed.");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <StatusNotice tone="info">Loading connected apps…</StatusNotice>;
  if (error) return <LoadErrorState message={error} onRetry={() => { void load(); }} />;

  if (!grants.length) {
    return (
      <StatusNotice tone="info">
        No external MCP clients have connected yet. Authorize a client (for example MCP Inspector) via OAuth; it will appear here.
      </StatusNotice>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {grants.map((grant) => (
        <li key={grant.id} className="rounded-lg border border-[var(--border)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--fg)]">{grant.clientName}</p>
              <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">
                {grant.kind} · {grant.access} access · client {grant.clientId}
              </p>
              <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">
                Last used {grant.lastUsedAt ? new Date(grant.lastUsedAt).toLocaleString() : "never"}
              </p>
            </div>
            <button
              type="button"
              className="text-xs font-semibold text-[var(--destructive)]"
              disabled={busyId === grant.id}
              onClick={() => { void revoke(grant.id); }}
            >
              Revoke
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}