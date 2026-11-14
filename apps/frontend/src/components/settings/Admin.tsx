import { type JSX, useCallback, useEffect, useState } from "react";
import { LoadErrorState } from "../LoadErrorState";
import { SkeletonLines } from "../surface";

interface AdminWorkspaceRow {
  workspaceId: string;
  name: string;
  memberCount: number;
  lastActivity: number | null;
}

export function AdminSettings(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<AdminWorkspaceRow[]>([]);
  const [tables, setTables] = useState<{ table: string; rows: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wsRes, tableRes] = await Promise.all([
        fetch("/api/governance/admin/workspaces"),
        fetch("/api/governance/admin/table-sizes"),
      ]);
      const wsBody = (await wsRes.json()) as { workspaces?: AdminWorkspaceRow[]; error?: string };
      const tableBody = (await tableRes.json()) as {
        tables?: { table: string; rows: number }[];
        error?: string;
      };
      if (!wsRes.ok) throw new Error(wsBody.error ?? "Admin workspaces unavailable.");
      if (!tableRes.ok) throw new Error(tableBody.error ?? "Admin metrics unavailable.");
      setWorkspaces(wsBody.workspaces ?? []);
      setTables(tableBody.tables ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonLines rows={5} />;
  if (error) return <LoadErrorState message={error} onRetry={() => void load()} />;

  return (
    <section className="flex flex-col gap-6 text-sm">
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--muted-foreground-2)]">
          Workspaces
        </h4>
        <ul className="divide-y divide-[var(--border-1)] rounded-lg border border-[var(--border-1)]">
          {workspaces.map((row) => (
            <li key={row.workspaceId} className="flex justify-between px-4 py-2">
              <span>{row.name}</span>
              <span className="text-[var(--muted-foreground-2)]">{row.memberCount} members</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--muted-foreground-2)]">
          D1 table sizes
        </h4>
        <ul className="divide-y divide-[var(--border-1)] rounded-lg border border-[var(--border-1)]">
          {tables.map((row) => (
            <li key={row.table} className="flex justify-between px-4 py-2">
              <span>{row.table}</span>
              <span className="text-[var(--muted-foreground-2)]">{row.rows}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
