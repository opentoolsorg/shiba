import { useEffect, useRef, useState } from "react";

export interface RenamedThread {
  id: string;
  name: string;
  updatedAt: number;
}

/** Named web sessions can be renamed; the default session and retained runs cannot. */
export function ThreadTitleEditor({
  sessionId,
  name,
  onRenamed,
}: {
  sessionId: string;
  name: string;
  onRenamed: (thread: RenamedThread) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scope = useRef(sessionId);
  scope.current = sessionId;

  useEffect(() => {
    setEditing(false);
    setDraft(name);
    setError(null);
    setBusy(false);
  }, [sessionId, name]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (sessionId === "default") return null;

  const save = async () => {
    const nextName = draft.trim();
    if (!nextName || inFlight.current) return;
    const requestedSession = sessionId;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        session?: RenamedThread;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Rename failed (${response.status}).`);
      if (
        body.session?.id !== requestedSession ||
        typeof body.session.name !== "string" ||
        typeof body.session.updatedAt !== "number"
      ) throw new Error("The server did not confirm the thread name. Retry to continue.");
      // The response belongs to its original thread even if the user has navigated away.
      onRenamed(body.session);
      if (scope.current === requestedSession) setEditing(false);
    } catch (cause) {
      if (scope.current === requestedSession) {
        setError(cause instanceof Error ? cause.message : "Thread could not be renamed.");
      }
    } finally {
      inFlight.current = false;
      if (scope.current === requestedSession) setBusy(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Rename thread"
        aria-expanded={editing}
        onClick={() => { setDraft(name); setError(null); setEditing((open) => !open); }}
        className="rounded-[var(--radius-button)] border border-[var(--border-1)] px-2 py-1 text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
      >
        Rename
      </button>
      {editing ? (
        <form
          aria-label="Rename thread"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) { event.stopPropagation(); setEditing(false); }
          }}
          className="absolute left-0 top-full z-30 mt-2 w-64 rounded-[var(--radius-button)] border border-[var(--border-2)] bg-[var(--panel)] p-3 shadow-[var(--sh-overlay)]"
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--fg)]">
            Thread name
            <input
              ref={inputRef}
              value={draft}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--bg)] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </label>
          {error ? <p role="alert" className="mt-2 text-xs text-[var(--destructive)]">{error}</p> : null}
          <div className="mt-3 flex justify-end gap-2 text-xs">
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" disabled={busy || !draft.trim()} className="rounded-[var(--radius-button)] bg-[var(--primary)] px-2 py-1 text-[var(--primary-text)] disabled:opacity-50">
              {busy ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
