import { z } from "zod";
import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";

export type WebSearchProvider = "tavily" | "exa" | "brave";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  query?: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  ok: boolean;
  provider?: WebSearchProvider;
  queries?: string[];
  results?: WebSearchResult[];
  /** Per-query failures in a batch; the other queries' results are still returned. */
  errors?: Array<{ query: string; error: string }>;
  error?: string;
  unavailableReason?: string;
}

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 8;
export const MAX_BATCHED_QUERIES = 5;

const domainPattern = /^-?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Agent-facing search input; every field but query is optional so older one-field callers keep working. */
export const webSearchInputShape = {
  query: z.union([
    z.string().min(1).max(MAX_QUERY_LENGTH),
    z.array(z.string().min(1).max(MAX_QUERY_LENGTH)).min(1).max(MAX_BATCHED_QUERIES),
  ]).describe(`The search query, or up to ${MAX_BATCHED_QUERIES} queries to run as one batch.`),
  maxResults: z.number().int().min(1).max(10).optional().describe("Results per query (default 8)."),
  domains: z.array(z.string().regex(domainPattern, "Use a bare domain like arxiv.org or -reddit.com.")).max(20).optional()
    .describe("Domain allowlist such as arxiv.org; prefix with '-' to exclude, e.g. -reddit.com."),
  recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only results from this recent window; use day or week for news."),
  country: z.string().regex(/^[a-z]{2}$/i).optional().describe("ISO 3166-1 alpha-2 country to bias results toward, e.g. US."),
};
export const webSearchInputSchema = z.object(webSearchInputShape);

export const WEB_SEARCH_DESCRIPTION =
  "Search the public web for current facts, news, and documentation. Batch up to 5 related queries, " +
  "scope with a domain allowlist (or '-domain' to exclude), and use recency for news. " +
  "Returns title, URL, snippet, and the query that found each result; cite the URLs you rely on.";
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
type SearchOptions = Omit<WebSearchInput, "query">;

function resolveProvider(env: Pick<Env, "WEB_SEARCH_PROVIDER">): WebSearchProvider {
  const raw = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (raw === "exa" || raw === "brave") return raw;
  return "tavily";
}

export function webSearchConfigured(env: Pick<Env, "WEB_SEARCH_API_KEY">): boolean {
  return Boolean(env.WEB_SEARCH_API_KEY?.trim());
}

export function webSearchQueries(input: Pick<WebSearchInput, "query">): string[] {
  const raw = Array.isArray(input.query) ? input.query : [input.query];
  return [...new Set(raw.map((query) => query.trim()).filter(Boolean))].slice(0, MAX_BATCHED_QUERIES);
}

export function splitDomains(domains: readonly string[] | undefined): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of domains ?? []) {
    const domain = raw.trim().toLowerCase();
    if (!domainPattern.test(domain)) continue;
    if (domain.startsWith("-")) exclude.push(domain.slice(1));
    else include.push(domain);
  }
  return { include, exclude };
}

const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 366 } as const;

/**
 * Tavily boosts by country name, from a published list whose spellings differ
 * from ICU's ("turkey" not "türkiye", "czech republic" not "czechia"), and it
 * rejects anything outside it. Map ISO 3166-1 alpha-2 through this table and
 * omit the parameter for any code it does not cover.
 */
const TAVILY_COUNTRIES: Record<string, string> = {
  af: "afghanistan", al: "albania", dz: "algeria", ad: "andorra", ao: "angola", ar: "argentina",
  am: "armenia", au: "australia", at: "austria", az: "azerbaijan", bs: "bahamas", bh: "bahrain",
  bd: "bangladesh", bb: "barbados", by: "belarus", be: "belgium", bz: "belize", bj: "benin",
  bt: "bhutan", bo: "bolivia", ba: "bosnia and herzegovina", bw: "botswana", br: "brazil",
  bn: "brunei", bg: "bulgaria", bf: "burkina faso", bi: "burundi", kh: "cambodia", cm: "cameroon",
  ca: "canada", cv: "cape verde", cf: "central african republic", td: "chad", cl: "chile",
  cn: "china", co: "colombia", km: "comoros", cg: "congo", cr: "costa rica", hr: "croatia",
  cu: "cuba", cy: "cyprus", cz: "czech republic", dk: "denmark", dj: "djibouti",
  do: "dominican republic", ec: "ecuador", eg: "egypt", sv: "el salvador",
  gq: "equatorial guinea", er: "eritrea", ee: "estonia", et: "ethiopia", fj: "fiji",
  fi: "finland", fr: "france", ga: "gabon", gm: "gambia", ge: "georgia", de: "germany",
  gh: "ghana", gr: "greece", gt: "guatemala", gn: "guinea", ht: "haiti", hn: "honduras",
  hu: "hungary", is: "iceland", in: "india", id: "indonesia", ir: "iran", iq: "iraq",
  ie: "ireland", il: "israel", it: "italy", jm: "jamaica", jp: "japan", jo: "jordan",
  kz: "kazakhstan", ke: "kenya", kw: "kuwait", kg: "kyrgyzstan", lv: "latvia",
  lb: "lebanon", ls: "lesotho", lr: "liberia", ly: "libya", li: "liechtenstein",
  lt: "lithuania", lu: "luxembourg", mg: "madagascar", mw: "malawi", my: "malaysia",
  mv: "maldives", ml: "mali", mt: "malta", mr: "mauritania", mu: "mauritius", mx: "mexico",
  md: "moldova", mc: "monaco", mn: "mongolia", me: "montenegro", ma: "morocco",
  mz: "mozambique", mm: "myanmar", na: "namibia", np: "nepal", nl: "netherlands",
  nz: "new zealand", ni: "nicaragua", ne: "niger", ng: "nigeria", kp: "north korea",
  mk: "north macedonia", no: "norway", om: "oman", pk: "pakistan", pa: "panama",
  pg: "papua new guinea", py: "paraguay", pe: "peru", ph: "philippines", pl: "poland",
  pt: "portugal", qa: "qatar", ro: "romania", ru: "russia", rw: "rwanda",
  sa: "saudi arabia", sn: "senegal", rs: "serbia", sg: "singapore", sk: "slovakia",
  si: "slovenia", so: "somalia", za: "south africa", kr: "south korea", ss: "south sudan",
  es: "spain", lk: "sri lanka", sd: "sudan", se: "sweden", ch: "switzerland", sy: "syria",
  tw: "taiwan", tj: "tajikistan", tz: "tanzania", th: "thailand", tg: "togo",
  tt: "trinidad and tobago", tn: "tunisia", tr: "turkey", tm: "turkmenistan", ug: "uganda",
  ua: "ukraine", ae: "united arab emirates", gb: "united kingdom", us: "united states",
  uy: "uruguay", uz: "uzbekistan", ve: "venezuela", vn: "vietnam", ye: "yemen",
  zm: "zambia", zw: "zimbabwe",
};

export function tavilyCountryName(code: string | undefined): string | undefined {
  return code ? TAVILY_COUNTRIES[code.toLowerCase()] : undefined;
}

function hostMatches(url: string, domains: readonly string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function searchTavily(apiKey: string, query: string, options: SearchOptions, maxResults: number): Promise<WebSearchResult[]> {
  const domains = splitDomains(options.domains);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      ...(domains.include.length ? { include_domains: domains.include } : {}),
      ...(domains.exclude.length ? { exclude_domains: domains.exclude } : {}),
      ...(options.recency ? { time_range: options.recency } : {}),
      ...(tavilyCountryName(options.country) ? { country: tavilyCountryName(options.country) } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Tavily search failed (${response.status}).`);
  const body = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
  return (body.results ?? []).map((row) => ({
    title: text(row.title), url: text(row.url), snippet: text(row.content).slice(0, 500),
    ...(row.published_date ? { publishedAt: text(row.published_date) } : {}),
  }));
}

async function searchExa(apiKey: string, query: string, options: SearchOptions, maxResults: number): Promise<WebSearchResult[]> {
  const domains = splitDomains(options.domains);
  const startPublishedDate = options.recency
    ? new Date(Date.now() - RECENCY_DAYS[options.recency] * 86_400_000).toISOString()
    : undefined;
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: "auto",
      contents: { text: { maxCharacters: 500 } },
      ...(domains.include.length ? { includeDomains: domains.include } : {}),
      ...(domains.exclude.length ? { excludeDomains: domains.exclude } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(options.country ? { userLocation: options.country.toUpperCase() } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Exa search failed (${response.status}).`);
  const body = (await response.json()) as { results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }> };
  return (body.results ?? []).map((row) => ({
    title: text(row.title), url: text(row.url), snippet: text(row.text).slice(0, 500),
    ...(row.publishedDate ? { publishedAt: text(row.publishedDate) } : {}),
  }));
}

async function searchBrave(apiKey: string, query: string, options: SearchOptions, maxResults: number): Promise<WebSearchResult[]> {
  const domains = splitDomains(options.domains);
  const operators = [
    domains.include.length ? `(${domains.include.map((domain) => `site:${domain}`).join(" OR ")})` : "",
    ...domains.exclude.map((domain) => `-site:${domain}`),
  ].filter(Boolean);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", [query, ...operators].join(" ").slice(0, 400));
  url.searchParams.set("count", String(maxResults));
  if (options.recency) url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[options.recency]);
  if (options.country) url.searchParams.set("country", options.country.toUpperCase());
  const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
  if (!response.ok) throw new Error(`Brave search failed (${response.status}).`);
  const body = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> } };
  return (body.web?.results ?? []).map((row) => ({
    title: text(row.title), url: text(row.url), snippet: text(row.description).slice(0, 500),
    ...(row.page_age ? { publishedAt: text(row.page_age) } : {}),
  }));
}

const PROVIDERS = { tavily: searchTavily, exa: searchExa, brave: searchBrave } as const;

/**
 * Worker-egress search only — the API key never enters the container.
 * Batched queries run in parallel; results are deduplicated by URL in query order,
 * and the domain filter is re-applied here so every provider honors it the same way.
 */
export async function runWebSearch(
  env: Pick<Env, "WEB_SEARCH_API_KEY" | "WEB_SEARCH_PROVIDER">,
  input: string | WebSearchInput,
): Promise<WebSearchResponse> {
  const parsed = webSearchInputSchema.safeParse(typeof input === "string" ? { query: input } : input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid web search input." };
  }
  const queries = webSearchQueries(parsed.data);
  if (!queries.length) return { ok: false, error: `Query must be non-empty and at most ${MAX_QUERY_LENGTH} characters.` };
  const apiKey = env.WEB_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, unavailableReason: "web search not configured", error: "Web search is not configured on this deployment." };
  }
  const provider = resolveProvider(env);
  const maxResults = parsed.data.maxResults ?? MAX_RESULTS;
  const domains = splitDomains(parsed.data.domains);
  try {
    const settled = await Promise.allSettled(queries.map(async (query) =>
      (await PROVIDERS[provider](apiKey, query, parsed.data, maxResults)).slice(0, maxResults).map((row) => ({ ...row, query }))));
    const scrub = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return redactSecrets(message.split(apiKey).join("[redacted]"));
    };
    // One failed query must not discard the rest of the batch it was charged for.
    const errors = settled.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [{ query: queries[index]!, error: scrub(outcome.reason) }] : []);
    const batches = settled.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    if (!batches.length) return { ok: false, provider, queries, error: errors[0]?.error ?? "Web search failed.", errors };
    const seen = new Set<string>();
    const results = batches.flat().filter((row) => {
      if (!row.url.startsWith("https://") || seen.has(row.url)) return false;
      if (domains.include.length && !hostMatches(row.url, domains.include)) return false;
      if (hostMatches(row.url, domains.exclude)) return false;
      seen.add(row.url);
      return true;
    });
    return { ok: true, provider, queries, results, ...(errors.length ? { errors } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, provider, error: redactSecrets(message.split(apiKey).join("[redacted]")) };
  }
}
