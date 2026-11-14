import { type JSX, useCallback, useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { LoadErrorState } from "../LoadErrorState";
import { SkeletonLines } from "../surface";

interface ArchivedItem {
  resourceKind: string;
  resourceId: string;
  title: string;
  archivedAt: number;
  restoreSupported: boolean;
}

export function ArchivedSettings({ workspaceId }: { workspaceId?: string }): JSX.Element {
  const [items, setItems] = useState<ArchivedItem[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/governance/${workspaceId}/archived`, {
        headers: teamWorkspaceHeaders(workspaceId),
      });
      const body = (await response.json()) as { items?: ArchivedItem[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Failed to load archived items.");
      setItems(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!workspaceId)
    return (
      <p className="text-sm text-[var(--muted-foreground-2)]">
        Select a team workspace to view archived resources.
      </p>
    );
  if (loading) return <SkeletonLines rows={4} />;
  if (error) return <LoadErrorState message={error} onRetry={() => void load()} />;

  return (
    <section className="rounded-lg border border-[var(--border-1)] divide-y divide-[var(--border-1)]">
      {items.length === 0 ? (
        <p className="p-4 text-sm text-[var(--muted-foreground-2)]">Nothing archived yet.</p>
      ) : null}
      {items.map((item) => (
        <ArchivedRow
          key={`${item.resourceKind}:${item.resourceId}`}
          item={item}
          workspaceId={workspaceId}
          onRestored={() => void load()}
        />
      ))}
    </section>
  );
}

function ArchivedRow({
  item,
  workspaceId,
  onRestored,
}: {
  item: ArchivedItem;
  workspaceId: string;
  onRestored: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <div>
        <p className="font-medium">{item.title}</p>
        <p className="text-xs text-[var(--muted-foreground-2)]">
          {item.resourceKind} · {new Date(item.archivedAt).toLocaleString()}
        </p>
      </div>
      {item.restoreSupported ? (
        <RestoreButton workspaceId={workspaceId} item={item} onRestored={onRestored} />
      ) : null}
    </div>
  );
}

function RestoreButton({
  workspaceId,
  item,
  onRestored,
}: {
  workspaceId: string;
  item: ArchivedItem;
  onRestored: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const path =
    item.resourceKind === "skill"
      ? `/api/v1/extensions/skills/${item.resourceId}/restore`
      : item.resourceKind === "task"
        ? `/api/work/tasks/${item.resourceId}/restore`
        : item.resourceKind === "custom_agent"
          ? `/api/custom-agents/${item.resourceId}/restore`
          : null;
  if (!path) return <span className="text-xs text-[var(--muted-foreground-2)]">—</span>;
  return (
    <button
      type="button"
      disabled={busy}
      className="text-xs font-semibold text-[var(--primary)] disabled:opacity-50"
      onClick={() => {
        setBusy(true);
        void fetch(path, { method: "POST", headers: teamWorkspaceHeaders(workspaceId) })
          .then((response) => {
            if (!response.ok) throw new Error("Restore failed.");
            onRestored();
          })
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      Restore
    </button>
  );
}
