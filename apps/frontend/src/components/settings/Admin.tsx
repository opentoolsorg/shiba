import { type JSX, type ReactNode, useCallback, useEffect, useState } from "react";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";
import { SkeletonLines } from "../surface";

interface AdminWorkspaceRow {
  workspaceId: string;
  name: string;
  memberCount: number;
  lastActivity: number | null;
}

export function AdminSettings({ onOpenTeam }: { onOpenTeam?: () => void }): JSX.Element {
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
      if (wsRes.status === 401 || wsRes.status === 403 || tableRes.status === 401 || tableRes.status === 403) {
        throw new Error("Administrator access is required. Admin data appears only after the backend authorizes the request.");
      }
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
      <p className="text-xs text-[var(--muted-foreground-2)]">A read-only view of workspaces and database table sizes.</p>
      <AdminTable
        title="Workspaces"
        columns={["Name", "Members"]}
        empty="No workspaces reported."
        rows={workspaces.map((row) => ({ key: row.workspaceId, cells: [row.name, `${row.memberCount} members`] }))}
        footer={onOpenTeam ? <button type="button" onClick={onOpenTeam} className="min-h-11 text-xs font-semibold text-[var(--primary)]">Manage team →</button> : null}
      />
      <AdminTable
        title="D1 table sizes"
        columns={["Table", "Rows"]}
        empty="No tables reported."
        rows={tables.map((row) => ({ key: row.table, cells: [row.table, String(row.rows)] }))}
      />
    </section>
  );
}

function AdminTable({
  title,
  columns,
  rows,
  empty,
  footer,
}: {
  title: string;
  columns: [string, string];
  rows: { key: string; cells: [string, string] }[];
  empty: string;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <div>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--muted-foreground-2)]">{title}</h4>
      <Card>
        <div className="flex justify-between border-b border-[var(--border-1)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
          <span>{columns[0]}</span>
          <span>{columns[1]}</span>
        </div>
        <ul className="divide-y divide-[var(--border-1)]">
          {rows.map((row) => (
            <li key={row.key} className="flex justify-between px-4 py-2">
              <span>{row.cells[0]}</span>
              <span className="text-[var(--muted-foreground-2)]">{row.cells[1]}</span>
            </li>
          ))}
        </ul>
        {rows.length === 0 ? <p className="px-4 py-3 text-xs text-[var(--muted-foreground-2)]">{empty}</p> : null}
      </Card>
      {footer}
    </div>
  );
}
