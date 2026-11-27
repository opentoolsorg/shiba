import { useState, type JSX } from "react";

export const CHIEF_NAME_MAX = 40;
const LINK = "inline-flex min-h-11 items-center text-xs text-[var(--primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
const FIELD = "min-h-11 min-w-0 flex-1 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm text-[var(--fg)]";
const BTN = "inline-flex min-h-11 items-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 text-xs font-medium text-[var(--fg)] hover:bg-[var(--card-hover)] disabled:opacity-50";

/** Inline rename; `onSave` persists server-side and throws a user-readable Error on failure. */
export function ChiefRenameForm({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!editing) return <button type="button" className={LINK} onClick={() => { setDraft(name); setError(null); setEditing(true); }}>Rename</button>;
  const trimmed = draft.trim();
  const save = async () => {
    if (!trimmed || trimmed.length > CHIEF_NAME_MAX) { setError(`Enter a name of 1-${CHIEF_NAME_MAX} characters.`); return; }
    setBusy(true);
    setError(null);
    try { await onSave(trimmed); setEditing(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Rename failed."); }
    finally { setBusy(false); }
  };
  return <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label="Chief of staff name" className={FIELD} value={draft} maxLength={CHIEF_NAME_MAX} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className={BTN} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className={BTN} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
    </div>
    {error ? <p role="alert" className="text-xs text-[var(--fg)]">{error}</p> : null}
  </form>;
}
