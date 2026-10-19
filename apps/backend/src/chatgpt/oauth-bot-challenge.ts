/**
 * Detect Cloudflare / edge bot-challenge HTML masquerading as OAuth failures.
 * Workers egress to auth.openai.com may receive 403 + text/html (2026-10-19).
 */
export function looksLikeBotChallengeBody(body: string): boolean {
  const sample = body.slice(0, 4096).toLowerCase();
  if (sample.includes("<!doctype html") || sample.includes("<html")) {
    return (
      sample.includes("cf-browser-verification") ||
      sample.includes("challenge-platform") ||
      sample.includes("just a moment") ||
      sample.includes("attention required")
    );
  }
  return false;
}

export function isOAuthBotChallengeResponse(response: Response, body?: string): boolean {
  if (response.status !== 403 && response.status !== 503) return false;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) return true;
  if (body !== undefined && looksLikeBotChallengeBody(body)) return true;
  return false;
}
