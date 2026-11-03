import type { FindingSeverity, ReviewFinding, ReviewRound } from "@shiba/shared";
import { selectPostable } from "@shiba/shared";
import { fetchWithBackoff } from "../http-retry.js";
import { redactSecrets } from "../security.js";

export interface PostReviewDeps {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  credentialMode?: "pat" | "app";
  /** Findings at or above this severity become inline comments. Default medium. */
  inlineThreshold?: FindingSeverity;
}

const API_BASE = "https://api.github.com";

/** GitHub may have accepted the review. A retry could create a second copy. */
export class ReviewPublicationUnknownError extends Error {
  constructor(message: string) {
    super(redactSecrets(message));
    this.name = "ReviewPublicationUnknownError";
  }
}

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
  if (round.publicationOutcome === "unknown") {
    throw new ReviewPublicationUnknownError("Review publication outcome is unknown. Inspect GitHub before retrying.");
  }
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const apiBase = (deps.apiBase ?? API_BASE).replace(/\/$/, "");
  const { owner, repo, number, headSha } = round.pull;
  const path = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
  try {
    let publisherLogin: string | undefined;
    if (round.githubReviewId === undefined && deps.credentialMode !== "app") {
      const identityRes = await fetchWithBackoff(`${apiBase}/user`, { headers: headers(token) }, {
        fetchImpl,
        attempts: 3,
        baseDelayMs: 200,
      });
      const identityText = await identityRes.text();
      if (!identityRes.ok) throw new Error(`GitHub identity failed ${identityRes.status}: ${identityText.slice(0, 300)}`);
      publisherLogin = (JSON.parse(identityText) as { login?: string }).login;
      if (!publisherLogin) throw new Error("GitHub identity response missing login.");
    }
    const listed = await fetchWithBackoff(`${apiBase}${path}`, { headers: headers(token) }, {
      fetchImpl,
      attempts: 3,
      baseDelayMs: 200,
    });
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
          (review as { body: string }).body.includes(tag) &&
          (round.githubReviewId === undefined
            ? publisherLogin !== undefined && (review as { user?: { login?: string } }).user?.login === publisherLogin
            : (review as { id?: number }).id === round.githubReviewId),
      ) as { id?: number; html_url?: string } | undefined;
      if (existing?.id !== undefined) {
        return { githubReviewId: existing.id, url: existing.html_url ?? "" };
      }
    }
    const { inline, bodyOnly } = selectPostable(round.findings, deps.inlineThreshold ?? "medium");
    const body = [
      round.summary,
      tag,
      ...bodyOnly.map((finding) => `- ${finding.severity} ${finding.path}:${finding.line} ${finding.title}`),
    ].filter((part) => part !== "").join("\n\n");
    let created: Response;
    try {
      created = await fetchImpl(`${apiBase}${path}`, {
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
    } catch (error) {
      throw new ReviewPublicationUnknownError(`Review publication response was lost: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!created.ok) {
      const detail = await created.text().catch(() => "Response body unavailable.");
      if (created.status === 408 || created.status >= 500) {
        throw new ReviewPublicationUnknownError(`Review publication returned an uncertain HTTP ${created.status}: ${detail.slice(0, 300)}`);
      }
      throw new Error(`GitHub create review failed ${created.status}: ${detail.slice(0, 300)}`);
    }
    try {
      const review: unknown = JSON.parse(await created.text());
      if (typeof review !== "object" || review === null || !Number.isSafeInteger((review as { id?: unknown }).id) ||
          ((review as { id: number }).id) < 1 ||
          ((review as { html_url?: unknown }).html_url !== undefined && typeof (review as { html_url?: unknown }).html_url !== "string")) {
        throw new Error("GitHub returned an invalid review receipt.");
      }
      const receipt = review as { id: number; html_url?: string };
      return { githubReviewId: receipt.id, url: receipt.html_url ?? "" };
    } catch (error) {
      throw new ReviewPublicationUnknownError(`Review publication receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    if (error instanceof ReviewPublicationUnknownError) throw error;
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
