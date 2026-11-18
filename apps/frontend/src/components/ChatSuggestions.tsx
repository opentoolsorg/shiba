import { useEffect, useState, type JSX } from "react";

export function chatSuggestionsUrl(agentName: string): string {
  return `/agents/coding-orchestrator/${encodeURIComponent(agentName)}/chat-suggestions`;
}

/** Suggested next prompts for a chat thread; renders nothing until the backend returns some. */
export function ChatSuggestions({ agentName, refreshKey, hidden = false, onPick }: { agentName: string; refreshKey: string; hidden?: boolean; onPick: (prompt: string) => void }): JSX.Element | null {
  const [loaded, setLoaded] = useState<{ key: string; suggestions: string[] } | null>(null);
  const key = `${agentName}:${refreshKey}`;
  useEffect(() => {
    const abort = new AbortController();
    fetch(chatSuggestionsUrl(agentName), { credentials: "include", signal: abort.signal })
      .then(async (response) => response.ok ? await response.json() as { suggestions?: unknown } : {})
      .then((body) => {
        const suggestions = Array.isArray(body.suggestions) ? body.suggestions.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 3) : [];
        if (!abort.signal.aborted) setLoaded({ key, suggestions });
      })
      .catch(() => { if (!abort.signal.aborted) setLoaded({ key, suggestions: [] }); });
    return () => abort.abort();
  }, [agentName, key]);
  const suggestions = loaded?.key === key ? loaded.suggestions : [];
  if (hidden || !suggestions.length) return null;
  return (
    <div role="group" aria-label="Suggested prompts" className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2">
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
    </div>
  );
}
