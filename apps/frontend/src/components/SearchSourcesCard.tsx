import type { JSX } from "react";
import { BookOpen, Globe2 } from "lucide-react";

type WebRow = { title?: unknown; url?: unknown; snippet?: unknown; query?: unknown };
type KnowledgeRow = { sourceName?: unknown; sourceKind?: unknown; scope?: unknown; text?: unknown; chunkId?: unknown };
type Source = { key: string; title: string; detail: string; snippet: string; href: string | null };

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** Reads a web_search or knowledge_search tool output into display rows; anything else renders nothing. */
export function searchSources(tool: string, output: unknown): { sources: Source[]; message: string | null } | null {
  if (tool !== "web_search" && tool !== "knowledge_search") return null;
  if (!output || typeof output !== "object") return null;
  const body = output as { ok?: unknown; results?: unknown; hits?: unknown; error?: unknown; message?: unknown };
  if (body.ok === false) return { sources: [], message: str(body.message) || str(body.error) || "The lookup did not complete." };
  if (tool === "web_search") {
    const rows = Array.isArray(body.results) ? body.results as WebRow[] : [];
    return {
      message: rows.length ? null : "No web results.",
      sources: rows.flatMap((row, index) => {
        const url = str(row.url);
        if (!url.startsWith("https://")) return [];
        return [{ key: `${url}:${index}`, title: str(row.title) || host(url), detail: host(url), snippet: str(row.snippet), href: url }];
      }),
    };
  }
  const rows = Array.isArray(body.hits) ? body.hits as KnowledgeRow[] : [];
  return {
    message: rows.length ? null : "No matching files or notes.",
    sources: rows.map((row, index) => ({
      key: str(row.chunkId) || String(index),
      title: str(row.sourceName) || (row.sourceKind === "note" ? "Untitled note" : "Untitled file"),
      detail: [row.sourceKind === "note" ? "Note" : "File", row.scope === "workspace" ? "Workspace" : row.scope === "personal" ? "Personal" : ""].filter(Boolean).join(" · "),
      snippet: str(row.text),
      href: null,
    })),
  };
}

export function SearchSourcesCard({ tool, output }: { tool: string; output: unknown }): JSX.Element | null {
  const parsed = searchSources(tool, output);
  if (!parsed) return null;
  const Icon = tool === "web_search" ? Globe2 : BookOpen;
  const heading = tool === "web_search" ? "Web sources" : "Knowledge sources";
  return (
    <section aria-label={heading} className="max-w-[92%] md:max-w-[85%] border border-[var(--border-1)] bg-[var(--card)] rounded-[var(--radius-button)]">
      <header className="flex items-center gap-2 border-b border-[var(--border-1)] px-3 py-2 text-[11px] font-mono uppercase tracking-wide text-[var(--muted-foreground-2)]">
        <Icon aria-hidden="true" className="size-3.5" />
        {heading}
        {parsed.sources.length ? <span className="tabular-nums">· {parsed.sources.length}</span> : null}
      </header>
      {parsed.message ? <p className="px-3 py-2 text-xs text-[var(--muted-foreground-2)]">{parsed.message}</p> : null}
      {parsed.sources.length ? (
        <ol className="divide-y divide-[var(--border-1)]">
          {parsed.sources.map((source, index) => (
            <li key={source.key} className="flex gap-3 px-3 py-2">
              <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-[var(--muted-foreground-3)]">{index + 1}</span>
              <span className="min-w-0 flex-1">
                {source.href ? (
                  <a href={source.href} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-[var(--fg)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
                    {source.title}
                  </a>
                ) : <span className="block truncate text-sm font-medium text-[var(--fg)]">{source.title}</span>}
                <span className="block truncate font-mono text-[11px] text-[var(--muted-foreground-2)]">{source.detail}</span>
                {source.snippet ? <span className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground-1)]">{source.snippet}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
