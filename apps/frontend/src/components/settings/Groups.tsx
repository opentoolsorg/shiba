import type { WorkspaceGroup } from "@shiba/shared";
import { type FormEvent, type JSX, useCallback, useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { LoadErrorState } from "../LoadErrorState";
import { SkeletonLines } from "../surface";

export function GroupsSettings({ workspaceId }: { workspaceId?: string }): JSX.Element {
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/governance/${workspaceId}/groups`, {
        headers: teamWorkspaceHeaders(workspaceId),
      });
      const body = (await response.json()) as { groups?: WorkspaceGroup[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Failed to load groups.");
      setGroups(body.groups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!workspaceId || !name.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/governance/${workspaceId}/groups`, {
        method: "POST",
        headers: { ...teamWorkspaceHeaders(workspaceId), "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Create failed.");
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceId)
    return (
      <p className="text-sm text-[var(--muted-foreground-2)]">
        Select a team workspace to manage groups.
      </p>
    );
  if (loading) return <SkeletonLines rows={3} />;
  if (error) return <LoadErrorState message={error} onRetry={() => void load()} />;

  return (
    <section className="flex flex-col gap-4">
      <form onSubmit={(e) => void onCreate(e)} className="flex gap-2">
        <input
          className="h-9 flex-1 rounded-lg border border-[var(--border-1)] px-3 text-sm"
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="h-9 rounded-lg bg-[var(--primary)] px-3 text-xs font-medium text-white disabled:opacity-50"
        >
          Create
        </button>
      </form>
      <ul className="divide-y divide-[var(--border-1)] rounded-lg border border-[var(--border-1)]">
        {groups.length === 0 ? (
          <li className="p-4 text-sm text-[var(--muted-foreground-2)]">No groups yet.</li>
        ) : null}
        {groups.map((group) => (
          <li key={group.groupId} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium">{group.name}</span>
            <span className="text-[var(--muted-foreground-2)]">{group.groupId}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
