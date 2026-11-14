import { useCallback, useEffect, useState, type FormEvent, type JSX } from "react";
import type { SlackImportJob } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { Card } from "../settings-ui";

interface RoomOption {
  roomId: string;
  title: string;
}

export function SlackImportSection(): JSX.Element {
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [roomId, setRoomId] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [job, setJob] = useState<SlackImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadRooms = useCallback(() => {
    void fetch("/api/collaboration/rooms", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { rooms?: RoomOption[] };
        setRooms(body.rooms ?? []);
        if (!roomId && body.rooms?.[0]?.roomId) setRoomId(body.rooms[0].roomId);
      })
      .catch(() => {});
  }, [roomId]);

  useEffect(() => {
    reloadRooms();
  }, [reloadRooms]);

  const refreshJob = useCallback(
    (jobId: string) => {
      void fetch(`/api/slack-import/${encodeURIComponent(jobId)}`, {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { job?: SlackImportJob };
          if (body.job) setJob(body.job);
        })
        .catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (!job?.jobId || job.status === "completed" || job.status === "cancelled" || job.status === "failed") {
      return;
    }
    const timer = window.setInterval(() => refreshJob(job.jobId), 3_000);
    return () => window.clearInterval(timer);
  }, [job?.jobId, job?.status, refreshJob]);

  const startImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomId.trim() || !slackTeamId.trim() || !slackChannelId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/slack-import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: roomId.trim(),
          slackTeamId: slackTeamId.trim(),
          slackChannelId: slackChannelId.trim(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { job?: SlackImportJob; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status}).`);
      if (body.job) setJob(body.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelJob = async () => {
    if (!job?.jobId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/slack-import/${encodeURIComponent(job.jobId)}/cancel`, {
        method: "POST",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => ({}))) as { job?: SlackImportJob; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Cancel failed (${response.status}).`);
      if (body.job) setJob(body.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <LoadErrorState message={error} onRetry={reloadRooms} /> : null}
      <Card>
        <form onSubmit={(event) => void startImport(event)} className="flex flex-col gap-3 px-4 py-4">
          <p className="text-xs text-[var(--muted-foreground-2)]">
            Import Slack channel history into a collaboration room. Requires workspace Slack configuration.
          </p>
          <label className="flex flex-col gap-1 text-xs text-[var(--fg)]">
            Target room
            <select
              aria-label="Slack import target room"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
              className="min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-2 text-sm"
            >
              {rooms.length === 0 ? <option value="">No rooms yet</option> : null}
              {rooms.map((room) => (
                <option key={room.roomId} value={room.roomId}>
                  {room.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--fg)]">
            Slack team ID
            <input
              aria-label="Slack team ID"
              value={slackTeamId}
              onChange={(event) => setSlackTeamId(event.target.value)}
              className="min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-2 font-mono text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--fg)]">
            Slack channel ID
            <input
              aria-label="Slack channel ID"
              value={slackChannelId}
              onChange={(event) => setSlackChannelId(event.target.value)}
              className="min-h-11 border border-[var(--border-1)] bg-[var(--input)] px-2 font-mono text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !roomId || !slackTeamId.trim() || !slackChannelId.trim()}
            className="self-start border border-[var(--primary)]/30 bg-[var(--primary-soft)] px-3 py-2 text-xs font-semibold text-[var(--primary)] disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start Slack import"}
          </button>
        </form>
      </Card>
      {job ? (
        <Card>
          <div className="space-y-2 px-4 py-3 text-xs">
            <p className="font-mono text-[var(--fg)]">Job {job.jobId}</p>
            <p className="text-[var(--muted-foreground-2)]">
              Status: {job.status} · imported {job.importedCount}
              {job.cursorTs ? ` · cursor ${job.cursorTs}` : ""}
            </p>
            {(job.status === "pending" || job.status === "running") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancelJob()}
                className="border border-[var(--border-1)] px-2 py-1 text-[11px]"
              >
                Cancel import
              </button>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}