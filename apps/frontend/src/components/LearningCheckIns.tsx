import { useEffect, useState } from "react";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const endpoint = "/api/learning/check-ins";
type CheckIn = { id: string; task: string };

export function LearningCheckIns({ workspaceId }: { workspaceId?: string }) {
  const [checkIns, setCheckIns] = useState<CheckIn[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, {
      credentials: "same-origin",
      headers: teamWorkspaceHeaders(workspaceId),
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { checkIns: CheckIn[] };
      if (!controller.signal.aborted && Array.isArray(body.checkIns)) setCheckIns(body.checkIns);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [workspaceId]);

  async function dismiss(id: string) {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
        credentials: "same-origin",
        headers: teamWorkspaceHeaders(workspaceId),
      });
      if (!response.ok) throw new Error("Dismiss failed");
      setCheckIns((rows) => rows.filter((row) => row.id !== id));
    } catch {
      setError(id);
    } finally {
      setBusy(null);
    }
  }

  if (!checkIns.length) return null;
  return (
    <section aria-label="Learning check-ins" className="mb-3 shrink-0 border border-[var(--border-1)] bg-[var(--card)]">
      <h2 className="border-b border-[var(--border-1)] px-4 py-3 font-display text-xl text-[var(--fg)] sm:px-5">Learning check-ins</h2>
      <ul className="divide-y divide-[var(--border-1)]">
        {checkIns.map(({ id, task }) => (
          <li key={id} className="px-4 py-3 sm:px-5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted-foreground-2)]">Automation suggestion</p>
            <p className="mt-1 break-words text-sm font-medium text-[var(--fg)]">{task}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground-2)]">You’ve asked for this on different days. It might be worth scheduling. No routine was created.</p>
            <button type="button" disabled={busy !== null} onClick={() => { void dismiss(id); }} className="min-h-11 text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50">
              {busy === id ? "Dismissing…" : "Dismiss"}
            </button>
            {error === id ? <p role="alert" className="text-xs text-[var(--destructive)]">Couldn’t dismiss this suggestion. Try again.</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
