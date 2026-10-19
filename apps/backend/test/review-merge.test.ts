import { describe, expect, it, vi } from "vitest";
import { mergePullRequest } from "../src/review/merge.js";

describe("mergePullRequest", () => {
  it("PUTs merge with expected head sha", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ merged: true, sha: "deadbeef" }), { status: 200 });
    });
    const result = await mergePullRequest(
      { owner: "acme", repo: "widgets", number: 2, expectedHeadSha: "a".repeat(40), mergeMethod: "squash" },
      "token",
      { fetchImpl, apiBase: "https://api.example.com" },
    );
    expect(result.merged).toBe(true);
    expect(calls[0]?.init?.method).toBe("PUT");
    const body = JSON.parse(String(calls[0]?.init?.body)) as { sha: string; merge_method: string };
    expect(body.merge_method).toBe("squash");
    expect(body.sha).toHaveLength(40);
  });
});
