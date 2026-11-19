/** Guided paste-in of what another assistant already knows, saved as a private memory source. */
import { forwardRef, useState, type FormEvent, type JSX } from "react";
import { Check, Copy, LockKeyhole } from "lucide-react";
import type { MemorySource } from "./MemorySourcesView";

export const CONTEXT_IMPORT_PROMPT =
  "Help me prepare a context brief for a new work assistant. Summarize my role, current projects, goals, working preferences, and recurring tasks. Separate facts I told you from your inferences. Leave out passwords, keys, financial or health details, and private information about other people. Do not invent missing information.";

const ASSISTANTS = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "other", label: "Other" },
] as const;
type AssistantId = (typeof ASSISTANTS)[number]["id"];

const CONTROL =
  "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs font-medium text-[var(--ink)] hover:bg-[var(--card-hover)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--navy)]";
const STEP = "grid size-6 place-items-center border border-[var(--line)] font-mono text-[11px] tabular-nums text-[var(--ink-2)]";

export const AssistantContextImport = forwardRef<HTMLFormElement, {
  onImported: (source: MemorySource, redacted: number) => void | Promise<void>;
  disabled?: boolean;
}>(function AssistantContextImport({ onImported, disabled = false }, ref): JSX.Element {
  const [assistant, setAssistant] = useState<AssistantId>("chatgpt");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = disabled || saving;
  const askName = assistant === "other" ? "your assistant" : ASSISTANTS.find((item) => item.id === assistant)?.label;

  const copy = () => {
    if (!navigator.clipboard) { setError("Copy is unavailable here. Select the prompt text and copy it yourself."); return; }
    void navigator.clipboard.writeText(CONTEXT_IMPORT_PROMPT).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }, () => setError("Copy failed. Select the prompt text and copy it yourself."));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/memory/sources/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistant, content: text.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { source?: MemorySource; redacted?: number; error?: string };
      if (!response.ok || !body.source) throw new Error(body.error ?? "Context could not be saved. Review it and try again.");
      setText("");
      await onImported(body.source, body.redacted ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Context could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form ref={ref} tabIndex={-1} aria-label="Import context from another assistant" onSubmit={(event) => void save(event)}
      className="flex flex-col gap-3 border border-[var(--line)] bg-[var(--card)] p-4 text-[var(--ink)]">
      <div>
        <h3 className="text-base font-semibold">Bring context from another assistant</h3>
        <p className="mt-1 text-xs text-[var(--ink-2)]">Ask the assistant you already use what it knows about your work, then paste its reply here.</p>
      </div>
      <div role="radiogroup" aria-label="Assistant you use" className="flex flex-wrap gap-2">
        {ASSISTANTS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={assistant === item.id} disabled={busy}
            onClick={() => setAssistant(item.id)}
            className={`${CONTROL} ${assistant === item.id ? "border-[var(--navy)] text-[var(--navy)]" : ""}`}>
            {item.label}
          </button>
        ))}
      </div>
      <ol className="flex flex-col gap-4">
        <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5">
          <span aria-hidden className={STEP}>1</span>
          <div>
            <p className="text-sm">Ask {askName} this</p>
            <p data-testid="context-import-prompt" className="mt-2 border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-xs leading-relaxed text-[var(--ink-2)]">{CONTEXT_IMPORT_PROMPT}</p>
            <button type="button" onClick={copy} disabled={busy} className={`${CONTROL} mt-2 inline-flex items-center gap-1.5`}>
              {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>
        </li>
        <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5">
          <span aria-hidden className={STEP}>2</span>
          <label className="flex flex-col gap-2 text-sm">
            Paste its reply
            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={20_000} rows={5} disabled={busy}
              placeholder="Review it before saving. You can remove anything."
              className="w-full resize-y border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]" />
          </label>
        </li>
      </ol>
      <p className="flex items-center gap-1.5 text-xs text-[var(--ink-2)]">
        <LockKeyhole aria-hidden className="size-3.5 shrink-0" />
        Saved as a private memory source only you can see. Anything shaped like a key or token is redacted first.
      </p>
      {error ? <p role="alert" className="text-xs text-[var(--destructive-text)]">{error}</p> : null}
      <div>
        <button type="submit" disabled={busy || !text.trim()}
          className="min-h-11 border border-[var(--navy)] bg-[var(--navy)] px-3 py-2 text-xs font-medium text-[var(--paper)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--navy)]">
          {saving ? "Saving context…" : "Save context"}
        </button>
      </div>
    </form>
  );
});
