import { describe, expect, it, vi } from "vitest";
import { runWebSearch, tavilyCountryName } from "../src/tools/web-search.js";

const key = "partial-batch-key";

describe("web_search batch resilience", () => {
  it("keeps the queries that succeeded and reports the ones that failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query === "broken") return new Response("upstream unavailable", { status: 503 });
      return Response.json({ results: [{ title: query, url: `https://${query}.example.com/a`, content: "s" }] });
    }));
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: ["alpha", "broken", "gamma"] });
    vi.unstubAllGlobals();
    expect(result.ok).toBe(true);
    expect(result.results?.map((row) => row.query)).toEqual(["alpha", "gamma"]);
    expect(result.errors).toEqual([{ query: "broken", error: "Tavily search failed (503)." }]);
  });

  it("fails only when every query in the batch failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const result = await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: ["a", "b"] });
    vi.unstubAllGlobals();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("sends Tavily a country name instead of an ISO code, and omits an unknown one", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [] });
    }));
    await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: "q", country: "us" });
    await runWebSearch({ WEB_SEARCH_API_KEY: key }, { query: "q", country: "zz" });
    vi.unstubAllGlobals();
    expect(bodies[0]?.country).toBe("united states");
    expect(bodies[1]).not.toHaveProperty("country");
    expect(tavilyCountryName("GB")).toBe("united kingdom");
    expect(tavilyCountryName(undefined)).toBeUndefined();
  });

  it("sends Tavily's published spelling and drops countries it does not list", () => {
    expect(tavilyCountryName("tr")).toBe("turkey");
    expect(tavilyCountryName("cz")).toBe("czech republic");
    expect(tavilyCountryName("ba")).toBe("bosnia and herzegovina");
    expect(tavilyCountryName("hk")).toBeUndefined();
    expect(tavilyCountryName("la")).toBeUndefined();
    expect(tavilyCountryName("xx")).toBeUndefined();
  });
});
