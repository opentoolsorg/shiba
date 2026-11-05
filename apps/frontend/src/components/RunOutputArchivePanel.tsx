import { useEffect, useRef, useState } from "react";
import type { RunOutputArchivePage } from "@shiba/shared";
import { RunOutputArchiveClient } from "../run-output-archive-client";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const MAX_DISPLAY = 250_000;
export function RunOutputArchivePanel(props: { runId: string; sessionId: string; onClose: () => void }) {
  return <ArchiveContent key={`${props.runId}:${props.sessionId}`} {...props} />;
}
function ArchiveContent({ runId, sessionId, onClose }: { runId: string; sessionId: string; onClose: () => void }) {
  const [client] = useState(() => new RunOutputArchiveClient(runId, sessionId));
  const [page, setPage] = useState<RunOutputArchivePage | null>(null), [text, setText] = useState(""), [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [missing, setMissing] = useState(false);
  const controller = useRef<AbortController | null>(null), pending = useRef(false), currentPage = useRef(page); currentPage.current = page;
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clear = () => { currentPage.current = null; setPage(null); setText(""); setTotal(0); };
  const load = async (signal: AbortSignal, next = false) => {
    if (!active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setMissing(false);
    const previous = next ? currentPage.current : null;
    if (!next) clear();
    try {
      let id = previous?.archiveId;
      if (!id) {
        const records = await client.directory(signal); if (!active(signal)) return;
        if (!records.length) { setMissing(true); return; } id = records[0]!.id;
      }
      const value = await client.page(id, signal, previous ?? undefined); if (!active(signal)) return;
      const chunk = value.events.map((event) => event.event.data).join("");
      currentPage.current = value; setPage(value);
      setText((old) => `${previous ? old : ""}${chunk}`.slice(-MAX_DISPLAY)); setTotal((old) => (previous ? old : 0) + chunk.length);
    } catch { if (active(signal)) { clear(); setError("Current native archive access, source authority or checkpoint could not be verified. No work was restarted."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const current = new AbortController(); controller.current = current; pending.current = false; void load(current.signal);
    const refresh = () => { if (document.visibilityState !== "hidden") void load(current.signal); };
    const timer = window.setInterval(refresh, 20_000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { current.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: The wrapper fixes the run/session and all continuations require its exact controller.
  }, []);
  useEffect(() => {
    if (!page) return; const current = controller.current;
    const timer = window.setTimeout(() => { if (current && active(current.signal)) { clear(); setError("The private output archive lease expired."); } }, Math.min(2_147_483_647, Math.max(1, page.expiresAt - Date.now() + 1)));
    return () => window.clearTimeout(timer);
  }, [page]);
  return <section aria-label="Private retained terminal archive" className="min-w-0 border border-[var(--line)] bg-[var(--paper)] p-3 text-xs">
    <header className="flex flex-wrap items-center justify-between gap-2"><h4>Private retained terminal archive</h4><button type="button" className={BUTTON} onClick={onClose}>Close retained archive</button></header>
    <p className="mt-2">Read-only sanitized output for the original native account. Recovery never starts a command, model or replacement process. This is separate from the live display history.</p>
    <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal); }}>Refresh retained prefix</button>
    {busy && <p role="status" className="mt-2">Checking current native source authority…</p>}{error && <p role="alert" className="mt-2">{error}</p>}
    {missing && <p className="mt-2">No current private archive was approved for this run. Legacy, shared-context, local and personal runs keep their existing output behavior.</p>}
    {page && <><p className="mt-2">Expires {new Date(page.expiresAt).toISOString()} · source ACK {page.acknowledgedThrough} · last observed source {page.lastObservedSource} · retained events {page.eventCount}.</p>
      {page.incompleteTail ? <p role="status" className="mt-2">Only the externally acknowledged retained projection is available. The unacknowledged tail is unknown; this is not proof the command finished.</p>
        : <p role="status" className="mt-2">Original source exit receipt: {page.finalExitCode}. This does not establish tests, artifacts, settlement or publication.</p>}
      <pre data-testid="retained-archive-content" className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{text}</pre>
      {total > MAX_DISPLAY && <p className="mt-2">The panel shows the last {MAX_DISPLAY.toLocaleString()} characters from the loaded pages. Retained source pages remain separately bounded.</p>}
      {page.hasMore && <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { const signal = controller.current?.signal; if (signal) void load(signal, true); }}>Read next retained page</button>}
    </>}
  </section>;
}
