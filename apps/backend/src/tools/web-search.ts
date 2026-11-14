import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";

export type WebSearchProvider = "tavily" | "exa" | "brave";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  ok: boolean;
  results?: WebSearchResult[];
  error?: string;
  unavailableReason?: string;
}

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 8;

function resolveProvider(env: Pick<Env, "WEB_SEARCH_PROVIDER">): WebSearchProvider {
  const raw = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (raw === "exa" || raw === "brave") return raw;
  return "tavily";
}

export function webSearchConfigured(env: Pick<Env, "WEB_SEARCH_API_KEY">): boolean {
  return Boolean(env.WEB_SEARCH_API_KEY?.trim());
}

async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: false }),
  });
  if (!response.ok) throw new Error(`Tavily search failed (${response.status}).`);
  const body = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (body.results ?? []).slice(0, maxResults).map((row) => ({
    title: typeof row.title === "string" ? row.title : "",
    url: typeof row.url === "string" ? row.url : "",
    snippet: typeof row.content === "string" ? row.content.slice(0, 500) : "",
  })).filter((row) => row.url.startsWith("https://"));
}

async function searchExa(apiKey: string, query: string, maxResults: number): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, numResults: maxResults, type: "auto", contents: { text: { maxCharacters: 500 } } }),
  });
  if (!response.ok) throw new Error(`Exa search failed (${response.status}).`);
  const body = (await response.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (body.results ?? []).slice(0, maxResults).map((row) => ({
    title: typeof row.title === "string" ? row.title : "",
    url: typeof row.url === "string" ? row.url : "",
    snippet: typeof row.text === "string" ? row.text.slice(0, 500) : "",
  })).filter((row) => row.url.startsWith("https://"));
}

async function searchBrave(apiKey: string, query: string, maxResults: number): Promise<WebSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
  if (!response.ok) throw new Error(`Brave search failed (${response.status}).`);
  const body = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (body.web?.results ?? []).slice(0, maxResults).map((row) => ({
    title: typeof row.title === "string" ? row.title : "",
    url: typeof row.url === "string" ? row.url : "",
    snippet: typeof row.description === "string" ? row.description.slice(0, 500) : "",
  })).filter((row) => row.url.startsWith("https://"));
}

/** Worker-egress search only — the API key never enters the container. */
export async function runWebSearch(
  env: Pick<Env, "WEB_SEARCH_API_KEY" | "WEB_SEARCH_PROVIDER">,
  query: string,
  maxResults = MAX_RESULTS,
): Promise<WebSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: "Query must be non-empty and at most 500 characters." };
  }
  const apiKey = env.WEB_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, unavailableReason: "web search not configured", error: "Web search is not configured on this deployment." };
  }
  try {
    const provider = resolveProvider(env);
    const results = provider === "exa"
      ? await searchExa(apiKey, trimmed, maxResults)
      : provider === "brave"
        ? await searchBrave(apiKey, trimmed, maxResults)
        : await searchTavily(apiKey, trimmed, maxResults);
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}