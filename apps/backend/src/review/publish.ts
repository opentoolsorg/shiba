import type { ReviewFinding, ReviewRound } from "@shiba/shared";
import { selectPostable } from "@shiba/shared";
import { redactSecrets } from "../security.js";

export interface PostReviewDeps {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const API_BASE = "https://api.github.com";

function marker(roundId: string): string {
  return `<!-- shiba-review-round:${roundId} -->`;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "shiba",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function commentBody(finding: ReviewFinding): string {
  return `${finding.title}\n\n${finding.failureScenario}`;
}

/**
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews with event COMMENT.
 * Reuses a review whose body already contains the round marker.
 */
export async function postReview(
  round: ReviewRound,
  token: string,
  deps: PostReviewDeps = {},
): Promise<{ githubReviewId: number; url: string }> {
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const apiBase = (deps.apiBase ?? API_BASE).replace(/\/$/, "");
  const { owner, repo, number, headSha } = round.pull;
  const path = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
  try {
    const listed = await fetchImpl(`${apiBase}${path}`, { headers: headers(token) });
    const listedText = await listed.text();
    if (!listed.ok) throw new Error(`GitHub list reviews failed ${listed.status}: ${listedText.slice(0, 300)}`);
    const reviews: unknown = listedText ? JSON.parse(listedText) : [];
    const tag = marker(round.roundId);
    if (Array.isArray(reviews)) {
      const existing = reviews.find(
        (review) =>
          typeof review === "object" &&
          review !== null &&
          typeof (review as { body?: unknown }).body === "string" &&
          (review as { body: string }).body.includes(tag),
      ) as { id?: number; html_url?: string } | undefined;
      if (existing?.id !== undefined) {
        return { githubReviewId: existing.id, url: existing.html_url ?? "" };
      }
    }
    const { inline, bodyOnly } = selectPostable(round.findings, "medium");
    const body = [
      round.summary,
      tag,
      ...bodyOnly.map((finding) => `- ${finding.severity} ${finding.path}:${finding.line} ${finding.title}`),
    ].filter((part) => part !== "").join("\n\n");
    const created = await fetchImpl(`${apiBase}${path}`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        body,
        comments: inline.map((finding) => ({
          path: finding.path,
          line: finding.line,
          side: "RIGHT",
          body: commentBody(finding),
        })),
      }),
    });
    const createdText = await created.text();
    if (!created.ok) throw new Error(`GitHub create review failed ${created.status}: ${createdText.slice(0, 300)}`);
    const review = JSON.parse(createdText) as { id: number; html_url?: string };
    return { githubReviewId: review.id, url: review.html_url ?? "" };
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
