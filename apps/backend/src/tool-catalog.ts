/**
 * Tool-catalog port: the employee sees three model tools (search, describe,
 * call) instead of every schema in the prompt. Sources only describe tools the
 * current policy already selected; a catalog entry never grants access, and
 * every call still goes through the source's own policy and approval checks.
 */

export type ToolCatalogSourceId = "builtin" | "openconnector" | "mcp";

export interface ToolCatalogEntry {
  /** The exact name `tool_call` takes. */
  name: string;
  source: ToolCatalogSourceId;
  summary: string;
  /** "approval_required" means the call queues an exact-payload approval instead of running. */
  effect: "read" | "approval_required";
  resourceArgument?: string;
  resources?: string[];
  inputSchema?: Record<string, unknown>;
  /** Extra text used only for matching, never returned. */
  keywords?: string;
}

export interface ToolCatalogSource {
  id: ToolCatalogSourceId;
  /** Candidate entries for these lowercase terms. Local sources may return everything. */
  search(terms: string[], limit: number): Promise<ToolCatalogEntry[]>;
  /** Full entries (with schema) for names this source owns; unknown names are skipped. */
  describe(names: string[]): Promise<ToolCatalogEntry[]>;
  owns(name: string): boolean;
}

export const TOOL_SEARCH_LIMIT = 10;
export const TOOL_SEARCH_SCHEMA_RESULTS = 3;
export const TOOL_DESCRIBE_LIMIT = 5;
const SUMMARY_CHARS = 160;
export const MAX_ENTRY_SCHEMA_BYTES = 6_000;

export function searchTerms(queries: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const query of queries) {
    for (const term of query.toLowerCase().split(/[^a-z0-9]+/)) if (term.length >= 2) terms.add(term);
  }
  return [...terms].slice(0, 20);
}

function score(entry: ToolCatalogEntry, terms: readonly string[]): number {
  const name = entry.name.toLowerCase();
  const text = `${entry.summary} ${entry.keywords ?? ""}`.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (name.split(/[^a-z0-9]+/).includes(term)) total += 3;
    else if (name.includes(term)) total += 2;
    else if (text.includes(term)) total += 1;
  }
  return total;
}

function boundedSchema(schema: Record<string, unknown> | undefined) {
  if (!schema) return undefined;
  return JSON.stringify(schema).length <= MAX_ENTRY_SCHEMA_BYTES ? schema : undefined;
}

function publicEntry(entry: ToolCatalogEntry, withSchema: boolean) {
  const schema = withSchema ? boundedSchema(entry.inputSchema) : undefined;
  return {
    name: entry.name,
    source: entry.source,
    summary: entry.summary.length > SUMMARY_CHARS ? `${entry.summary.slice(0, SUMMARY_CHARS - 1)}…` : entry.summary,
    effect: entry.effect,
    ...(entry.resourceArgument ? { resourceArgument: entry.resourceArgument, resources: (entry.resources ?? []).slice(0, 20) } : {}),
    ...(schema ? { inputSchema: schema } : withSchema && entry.inputSchema ? { schemaOmitted: "too_large" as const } : {}),
  };
}

export class ToolCatalog {
  constructor(private readonly sources: readonly ToolCatalogSource[]) {}

  /** Up to 10 short matches; the best few carry their schema so a call can follow directly. */
  async search(queries: readonly string[]) {
    const terms = searchTerms(queries);
    const candidates = (await Promise.all(this.sources.map((source) => source.search(terms, TOOL_SEARCH_LIMIT)))).flat();
    const seen = new Set<string>();
    const ranked = candidates
      .filter((entry) => !seen.has(entry.name) && Boolean(seen.add(entry.name)))
      .map((entry, index) => ({ entry, index, score: score(entry, terms) }))
      .filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const matches = ranked.slice(0, TOOL_SEARCH_LIMIT)
      .map((item, index) => publicEntry(item.entry, index < TOOL_SEARCH_SCHEMA_RESULTS));
    return { matches, total: ranked.length, truncated: ranked.length > matches.length };
  }

  async describe(names: readonly string[]) {
    const wanted = [...new Set(names)].slice(0, TOOL_DESCRIBE_LIMIT);
    const found = (await Promise.all(this.sources.map((source) => {
      const owned = wanted.filter((name) => source.owns(name));
      return owned.length ? source.describe(owned) : Promise.resolve([]);
    }))).flat();
    const byName = new Map(found.map((entry) => [entry.name, entry]));
    return {
      tools: wanted.flatMap((name) => byName.has(name) ? [publicEntry(byName.get(name)!, true)] : []),
      unavailable: wanted.filter((name) => !byName.has(name)),
    };
  }

  sourceFor(name: string): ToolCatalogSource | undefined {
    return this.sources.find((source) => source.owns(name));
  }
}
