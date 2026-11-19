import { useEffect, useState, type JSX } from "react";

export function chatSuggestionsUrl(agentName: string): string {
  return `/agents/coding-orchestrator/${encodeURIComponent(agentName)}/chat-suggestions`;
}

/** Suggested next prompts for a chat thread; renders nothing until the backend returns some. Asks only while it could show them, so a prefilled draft never triggers a model call. */
export function ChatSuggestions({ agentName, refreshKey, busy = false, hidden = false, onPick }: { agentName: string; refreshKey: string; busy?: boolean; hidden?: boolean; onPick: (prompt: string) => void }): JSX.Element | null {
  const [loaded, setLoaded] = useState<{ key: string; suggestions: string[] } | null>(null);
  const key = `${agentName}:${refreshKey}`;
  const loadedKey = loaded?.key;
  useEffect(() => {
    if (busy || hidden || loadedKey === key) return;
    const abort = new AbortController();
    fetch(chatSuggestionsUrl(agentName), { method: "POST", credentials: "include", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (response) => response.ok ? await response.json() as { suggestions?: unknown } : {})
      .then((body) => {
        const suggestions = Array.isArray(body.suggestions) ? body.suggestions.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 3) : [];
        if (!abort.signal.aborted) setLoaded({ key, suggestions });
      })
      .catch(() => { if (!abort.signal.aborted) setLoaded({ key, suggestions: [] }); });
    return () => abort.abort();
  }, [agentName, key, busy, hidden, loadedKey]);
  const suggestions = loaded?.key === key ? loaded.suggestions : [];
  if (busy || hidden || !suggestions.length) return null;
  return (
    <section aria-label="Suggested prompts" className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onPick(suggestion)}
          className="min-h-11 max-w-full rounded-lg border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-left text-[13px] leading-snug text-[var(--fg)] transition-colors [@media(hover:hover)]:hover:bg-[var(--secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none"
        >
          {suggestion}
        </button>
      ))}
    </section>
  );
}

/** Puts a picked prompt in the composer, focused at its end, without sending it. */
export function focusComposerDraft(setDraft: (prompt: string) => void, prompt: string): void {
  setDraft(prompt);
  window.setTimeout(() => {
    const composer = document.querySelector<HTMLTextAreaElement>("[data-testid='chat-composer'] textarea");
    composer?.focus();
    composer?.setSelectionRange(prompt.length, prompt.length);
  }, 0);
}
