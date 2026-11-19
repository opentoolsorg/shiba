import { describe, expect, it, vi } from "vitest";
import { runWebSearch, webSearchConfigured } from "../src/tools/web-search.js";

describe("web_search tool", () => {
  it("reports unconfigured when the egress key is absent", async () => {
    expect(webSearchConfigured({})).toBe(false);
    const result = await runWebSearch({}, "Cloudflare Workflows pricing");
    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toBe("web search not configured");
  });

  it("never exposes the API key in responses", async () => {
    const fetchMock = vi.fn(async () => Response.json({ results: [{ title: "Pricing", url: "https://example.com", content: "Starts at $5" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const secret = "tavily-test-secret-should-not-leak";
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: secret, WEB_SEARCH_PROVIDER: "tavily" }, "pricing");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body.api_key).toBe(secret);
    vi.unstubAllGlobals();
  });
});

describe("web_search parity inputs", () => {
  const key = "search-test-key";
  const tavilyRows = (rows: Array<{ title: string; url: string; content?: string }>) => Response.json({ results: rows });

  it("runs batched queries in parallel, tags each result with its query, and dedupes by URL", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      return tavilyRows([
        { title: `${query} A`, url: "https://shared.example.com/a", content: "shared" },
        { title: `${query} B`, url: `https://${query}.example.com/b`, content: "unique" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: ["alpha", "beta", "alpha "] });
    vi.unstubAllGlobals();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.queries).toEqual(["alpha", "beta"]);
    expect(result.results?.map((row) => [row.query, row.url])).toEqual([
      ["alpha", "https://shared.example.com/a"],
      ["alpha", "https://alpha.example.com/b"],
      ["beta", "https://beta.example.com/b"],
    ]);
  });

  it("maps domain, recency, and country filters onto the Tavily request", async () => {
    const fetchMock = vi.fn(async () => tavilyRows([]));
    vi.stubGlobal("fetch", fetchMock);
    await runWebSearch({ WEB_SEARCH_API_KEY: key, WEB_SEARCH_PROVIDER: "tavily" },
      { query: "llm evals", domains: ["arxiv.org", "-reddit.com"], recency: "week", country: "us", maxResults: 3 });
    vi.unstubAllGlobals();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ query: "llm evals", max_results: 3, include_domains: ["arxiv.org"], exclude_domains: ["reddit.com"], time_range: "week", country: "united states" });
  });

  it("maps filters onto Exa and Brave requests", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => String(url).includes("brave")
      ? Response.json({ web: { results: [] } })
      : Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await runWebSearch({ WEB_SEARCH_API_KEY: key, WEB_SEARCH_PROVIDER: "exa" }, { query: "q", domains: ["arxiv.org", "-reddit.com"], recency: "day" });
    await runWebSearch({ WEB_SEARCH_API_KEY: key, WEB_SEARCH_PROVIDER: "brave" }, { query: "q", domains: ["arxiv.org", "-reddit.com"], recency: "month", country: "gb" });
    vi.unstubAllGlobals();
    const exa = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(exa).toMatchObject({ includeDomains: ["arxiv.org"], excludeDomains: ["reddit.com"] });
    expect(Date.now() - Date.parse(exa.startPublishedDate)).toBeLessThan(2 * 86_400_000);
    const brave = new URL(String((fetchMock.mock.calls[1] as unknown as [URL])[0]));
    expect(brave.searchParams.get("q")).toBe("q (site:arxiv.org) -site:reddit.com");
    expect(brave.searchParams.get("freshness")).toBe("pm");
    expect(brave.searchParams.get("country")).toBe("GB");
  });

  it("re-applies the domain filter to provider results and drops non-https URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tavilyRows([
      { title: "paper", url: "https://arxiv.org/abs/1" },
      { title: "sub", url: "https://export.arxiv.org/abs/2" },
      { title: "off-list", url: "https://blog.example.com/x" },
      { title: "plain", url: "http://arxiv.org/abs/3" },
    ])));
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: "q", domains: ["arxiv.org"] });
    vi.unstubAllGlobals();
    expect(result.results?.map((row) => row.url)).toEqual(["https://arxiv.org/abs/1", "https://export.arxiv.org/abs/2"]);
  });

  it("rejects malformed input before any provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tooMany = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: ["a", "b", "c", "d", "e", "f"] });
    const badDomain = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: "q", domains: ["https://evil.example/path"] });
    vi.unstubAllGlobals();
    expect(tooMany.ok).toBe(false);
    expect(badDomain.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts the key from provider failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`upstream rejected ${key}`); }));
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: key }, "q");
    vi.unstubAllGlobals();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
  });
});
