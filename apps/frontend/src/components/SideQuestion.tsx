import { useEffect, useRef, useState, type JSX } from "react";

export function SideQuestion({ employeeId, threadId }: { employeeId: string; threadId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  return <div className="relative" ref={root}>
    <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} className="min-h-9 rounded-lg px-2 text-sm text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]">Ask on the side</button>
    {open ? <SideQuestionDialog key={`${employeeId}:${threadId}`} employeeId={employeeId} threadId={threadId} onClose={() => setOpen(false)} /> : null}
  </div>;
}

function SideQuestionDialog({ employeeId, threadId, onClose }: { employeeId: string; threadId: string; onClose: () => void }): JSX.Element {
  const [pairs, setPairs] = useState<{ question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); return () => controller.current?.abort(); }, []);
  async function ask() {
    if (busy || !question.trim()) return;
    const current = question.trim();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/employees/${encodeURIComponent(employeeId)}/side-question`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: current, earlier: pairs.slice(-20), threadId }), signal: abort.signal });
      const body = await response.json() as { answer?: string; error?: string };
      if (!response.ok || typeof body.answer !== "string") throw new Error(body.error ?? "The side question could not be answered.");
      if (!abort.signal.aborted) { setPairs((previous) => [...previous, { question: current, answer: body.answer! }].slice(-20)); setQuestion(""); }
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "The side question could not be answered.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <section role="dialog" aria-label="Ask on the side" className="absolute right-0 top-full z-20 mt-1 w-80 max-w-[85vw] rounded-xl border border-[var(--border-1)] bg-[var(--popover)] p-3 text-sm text-[var(--fg)] shadow-overlay">
    <div className="flex items-center justify-between gap-2"><h2 className="font-medium">Ask on the side</h2><button type="button" onClick={onClose} className="min-h-9 px-2">Close</button></div>
    <p className="text-xs text-[var(--muted-foreground-2)]">Uses this thread as context. No tools. Not saved to the thread; cleared when closed.</p>
    <ol aria-live="polite" className="my-3 max-h-64 space-y-3 overflow-y-auto">{pairs.map((pair, index) => <li key={index}><p className="font-medium whitespace-pre-wrap">{pair.question}</p><p className="mt-1 whitespace-pre-wrap">{pair.answer}</p></li>)}</ol>
    {error ? <p role="alert" className="mb-2 text-[var(--destructive)]">{error}</p> : null}
    <form onSubmit={(event) => { event.preventDefault(); void ask(); }} className="flex gap-2">
      <input ref={input} aria-label="Side question" maxLength={4000} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy} className="min-w-0 flex-1 rounded-lg border border-[var(--border-1)] bg-[var(--bg)] px-2 py-2" />
      <button type="submit" disabled={busy || !question.trim()} className="rounded-lg px-2 py-2 hover:bg-[var(--secondary)] disabled:opacity-50">{busy ? "Asking…" : "Ask"}</button>
    </form>
  </section>;
}
