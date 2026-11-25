import { type JSX, useCallback, useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";
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
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-foreground-2)]">
        <span>Resource</span>
        <span>Action</span>
      </div>
      <div className="divide-y divide-[var(--border-1)]">
        {items.length === 0 ? (
          <p className="p-4 text-sm text-[var(--muted-foreground-2)]">
            Nothing archived yet. Archived workspace resources appear here with their type and a restore action.
          </p>
        ) : null}
        {items.map((item) => (
          <ArchivedRow
            key={`${item.resourceKind}:${item.resourceId}`}
            item={item}
            workspaceId={workspaceId}
            onRestored={() => void load()}
          />
        ))}
      </div>
    </Card>
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
  const [failed, setFailed] = useState(false);
  const path =
    item.resourceKind === "skill"
      ? `/api/v1/extensions/skills/${item.resourceId}/restore`
      : item.resourceKind === "task"
        ? `/api/work/tasks/${item.resourceId}/restore`
        : item.resourceKind === "custom_agent"
          ? `/api/custom-agents/${item.resourceId}/restore`
          : null;
  if (!path) return <span className="text-xs text-[var(--muted-foreground-2)]">—</span>;
  const restore = () => {
    setBusy(true);
    setFailed(false);
    void fetch(path, { method: "POST", headers: teamWorkspaceHeaders(workspaceId) })
      .then((response) => {
        if (!response.ok) throw new Error("Restore failed.");
        onRestored();
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        className="min-h-11 text-xs font-semibold text-[var(--primary)] disabled:opacity-50"
        onClick={restore}
      >
        Restore
      </button>
      {failed ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-[var(--destructive)]">
          Restore failed. {item.title} is still archived.
          <button type="button" disabled={busy} onClick={restore} className="min-h-11 font-semibold text-[var(--primary)] underline disabled:opacity-50">
            Retry
          </button>
        </p>
      ) : null}
    </div>
  );
}
