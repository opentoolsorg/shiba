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