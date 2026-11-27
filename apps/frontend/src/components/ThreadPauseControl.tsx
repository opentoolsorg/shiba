import { useRef, useState } from "react";

export interface PausedThread {
  id: string;
  updatedAt: number;
  pausedAt?: number;
}

/** Shown wherever a paused thread refuses input; pausing never touches runs in flight or pending approvals. */
export const PAUSED_THREAD_COPY =
  "This thread is paused. New prompts are blocked until you resume it. Runs already in flight and pending approvals are not affected.";

export function ThreadPauseControl({
  sessionId,
  paused,
  onChanged,
}: {
  sessionId: string;
  paused: boolean;
  onChanged: (thread: PausedThread) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (sessionId === "default") return null;

  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      });
      const body = (await response.json().catch(() => ({}))) as { session?: PausedThread; error?: string };
      if (!response.ok || body.session?.id !== sessionId) {
        throw new Error(body.error === "thread_paused" ? PAUSED_THREAD_COPY : body.error ?? `Could not ${paused ? "resume" : "pause"} the thread (${response.status}).`);
      }
      onChanged(body.session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the thread.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {paused ? (
        <span className="border border-[var(--border-1)] px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider text-[var(--muted-foreground-1)]">Paused</span>
      ) : null}
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={paused ? "Resume thread" : "Pause thread"}
        className="min-h-11 min-w-11 rounded-[var(--radius-button)] border border-[var(--border-1)] px-3 text-xs font-medium text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)] hover:text-[var(--fg)] disabled:opacity-50"
      >
        {paused ? "Resume" : "Pause"}
      </button>
      {error ? <span role="alert" className="text-xs text-[var(--destructive,#dc2626)]">{error}</span> : null}
    </span>
  );
}
