import type { WorkspaceSharingPolicy } from "@shiba/shared";
import { type JSX, useCallback, useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { LoadErrorState } from "../LoadErrorState";
import { SkeletonLines } from "../surface";

export function SharingSettings({ workspaceId }: { workspaceId?: string }): JSX.Element {
  const [policy, setPolicy] = useState<WorkspaceSharingPolicy | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/governance/${workspaceId}/policy`, {
        headers: teamWorkspaceHeaders(workspaceId),
      });
      const body = (await response.json()) as { policy?: WorkspaceSharingPolicy; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Failed to load policy.");
      setPolicy(body.policy ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(field: "publicLinksAllowed" | "guestInvitesAllowed"): Promise<void> {
    if (!workspaceId || !policy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/governance/${workspaceId}/policy`, {
        method: "PATCH",
        headers: { ...teamWorkspaceHeaders(workspaceId), "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: policy.version,
          [field]: !policy[field],
        }),
      });
      const body = (await response.json()) as { policy?: WorkspaceSharingPolicy; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Update failed.");
      setPolicy(body.policy ?? policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceId)
    return (
      <p className="text-sm text-[var(--muted-foreground-2)]">
        Select a team workspace to edit sharing policy.
      </p>
    );
  if (loading) return <SkeletonLines rows={3} />;
  if (error) return <LoadErrorState message={error} onRetry={() => void load()} />;
  if (!policy)
    return <p className="text-sm text-[var(--muted-foreground-2)]">Policy unavailable.</p>;

  return (
    <section className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between rounded-lg border border-[var(--border-1)] px-4 py-3">
        <span>Public share links</span>
        <button
          type="button"
          disabled={busy}
          className="text-xs font-semibold text-[var(--primary)]"
          onClick={() => void toggle("publicLinksAllowed")}
        >
          {policy.publicLinksAllowed ? "On" : "Off"}
        </button>
      </label>
      <label className="flex items-center justify-between rounded-lg border border-[var(--border-1)] px-4 py-3">
        <span>Guest invites</span>
        <button
          type="button"
          disabled={busy}
          className="text-xs font-semibold text-[var(--primary)]"
          onClick={() => void toggle("guestInvitesAllowed")}
        >
          {policy.guestInvitesAllowed ? "On" : "Off"}
        </button>
      </label>
    </section>
  );
}
