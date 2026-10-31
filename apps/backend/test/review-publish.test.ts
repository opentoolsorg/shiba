import { describe, expect, it, vi } from "vitest";
import type { ReviewRound } from "@shiba/shared";
import { postReview } from "../src/review/publish.js";

const round: ReviewRound = {
  roundId: "run-1:abc",
  codingRunId: "run-1",
  reviewRunId: "review:run-1",
  pull: { owner: "acme", repo: "widgets", number: 4, headSha: "abc", url: "https://github.com/acme/widgets/pull/4" },
  status: "running",
  summary: "One high finding.",
  findings: [{
    id: "abcdabcdabcdabcd",
    path: "src/a.ts",
    line: 3,
    category: "bug",
    severity: "high",
    confidence: "confirmed",
    title: "Crash",
    failureScenario: "Empty input throws.",
    triage: "open",
  }, {
    id: "bbbbbbbbbbbbbbbb",
    path: "src/b.ts",
    line: 9,
    category: "maintainability",
    severity: "low",
    confidence: "investigate",
    title: "Name",
    failureScenario: "The name hides the unit.",
    triage: "open",
  }],
};

describe("postReview", () => {
  it("posts one COMMENT review and then reuses it", async () => {
    const reviews: Array<{ id: number; html_url: string; body: string; user?: { login: string } }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "shiba-bot" }), { status: 200 });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { event: string; commit_id: string; comments: Array<{ side: string; line: number }>; body: string };
        expect(body.event).toBe("COMMENT");
        expect(body.commit_id).toBe("abc");
        expect(body.comments).toEqual([expect.objectContaining({ side: "RIGHT", line: 3 })]);
        const review = { id: 9, html_url: "https://github.com/acme/widgets/pull/4#pullrequestreview-9", body: body.body, user: { login: "shiba-bot" } };
        reviews.push(review);
        return new Response(JSON.stringify(review), { status: 200 });
      }
      return new Response(JSON.stringify(reviews), { status: 200 });
    });
    const first = await postReview(round, "ghp_secret", { fetchImpl, apiBase: "http://127.0.0.1:8799" });
    const second = await postReview(round, "ghp_secret", { fetchImpl, apiBase: "http://127.0.0.1:8799" });
    expect(first.githubReviewId).toBe(9);
    expect(second.githubReviewId).toBe(9);
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    const posted = reviews[0]?.body ?? "";
    expect(posted).toContain("<!-- shiba-review-round:run-1:abc -->");
    expect(posted).toContain("src/b.ts:9");
  });
  it("publishes App reviews without /user and reuses only a recorded review ID", async () => {
    const reviews = [{ id: 8, body: "<!-- shiba-review-round:run-1:abc -->", user: { login: "attacker" } }];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).not.toMatch(/\/user$/);
      if (init?.method === "POST") return Response.json({ id: 9, html_url: "review-9" });
      return Response.json(reviews);
    });
    expect(await postReview(round, "installation-token", { fetchImpl, credentialMode: "app" }))
      .toEqual({ githubReviewId: 9, url: "review-9" });
    reviews.push({ id: 9, body: "<!-- shiba-review-round:run-1:abc -->", user: { login: "app[bot]" } });
    expect(await postReview({ ...round, githubReviewId: 9 }, "installation-token", { fetchImpl, credentialMode: "app" }))
      .toEqual({ githubReviewId: 9, url: "" });
    expect(fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

});
