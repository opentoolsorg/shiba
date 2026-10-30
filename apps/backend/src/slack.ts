/**
 * Slack request verification. HMAC-SHA256 over `v0:{timestamp}:{body}`
 * with a 5-minute replay window, per
 * https://docs.slack.dev/authentication/verifying-requests-from-slack
 *
 * Uses WebCrypto so it runs in Workers and in Vitest without modification.
 * Mirrors the shape of verifyGitHubWebhookSignature in src/security.ts.
 */

/** Maximum age of a Slack request timestamp, in seconds (5 minutes). */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

export type SlackHeaders = Headers | Record<string, string | null | undefined>;

function readHeader(headers: SlackHeaders, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | null | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      return record[key] ?? null;
    }
  }
  return null;
}

/** Constant-time string comparison. Length mismatch returns false. */
export function timingSafeEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const SLACK_POST_MESSAGE = "https://slack.com/api/chat.postMessage";
const SLACK_AUTH_TEST = "https://slack.com/api/auth.test";

/**
 * Bounded wait on any Slack write: a hung API must not stall the run's
 * critical path (progress posts share the emit loop) — callers still
 * decide whether the resulting timeout error is fatal.
 */
export const SLACK_POST_TIMEOUT_MS = 8000;

export class SlackPostRejectedError extends Error {
  constructor(message: string, readonly outcomeKnown = true) {
    super(message);
    this.name = "SlackPostRejectedError";
  }
}

/**
 * chat.postMessage to a channel (or thread when `threadTs` is set).
 * Throws on transport failure or a Slack `error` field — callers decide
 * whether a failed post is fatal (cards) or best-effort (progress).
 */
export async function postSlackMessageWithReceipt(
  token: string,
  input: { channel: string; threadTs?: string; text: string; blocks?: unknown[]; clientMsgId?: string },
): Promise<{ channel: string; ts: string }> {
  const response = await fetch(SLACK_POST_MESSAGE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    body: JSON.stringify({
      channel: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.clientMsgId ? { client_msg_id: input.clientMsgId } : {}),
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; channel?: string; ts?: string };
  if (!response.ok || json.ok !== true) {
    const error = typeof json.error === "string" ? json.error : `Slack API ${response.status}`;
    const outcomeKnown = response.status < 500 && !["fatal_error", "internal_error", "request_timeout"].includes(error);
    throw new SlackPostRejectedError(error, outcomeKnown);
  }
  if (typeof json.channel !== "string" || typeof json.ts !== "string") {
    throw new Error("Slack accepted the message but returned no receipt.");
  }
  return { channel: json.channel, ts: json.ts };
}

/** Backwards-compatible Slack post for best-effort callers that do not need a receipt. */
export async function postSlackMessage(
  token: string,
  input: { channel: string; threadTs?: string; text: string; blocks?: unknown[] },
): Promise<void> {
  await postSlackMessageWithReceipt(token, input);
}

/** Ask Slack which workspace the configured token belongs to; caller must compare team_id to the linked thread. */
export async function verifySlackBotInstallation(token: string): Promise<{ teamId: string; userId: string; botId: string }> {
  const response = await fetch(SLACK_AUTH_TEST, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean; team_id?: string; user_id?: string; bot_id?: string; error?: string;
  };
  if (!response.ok || json.ok !== true || typeof json.team_id !== "string" || typeof json.user_id !== "string" || typeof json.bot_id !== "string") {
    throw new SlackPostRejectedError(typeof json.error === "string" ? json.error : `Slack auth.test ${response.status}`, true);
  }
  return { teamId: json.team_id, userId: json.user_id, botId: json.bot_id };
}

/**
 * Verify an inbound Slack request. Returns true only when the `v0=` HMAC
 * signature matches the raw body and the timestamp is within 5 minutes of
 * `now` (defaults to Date.now()). Anything else — missing headers, missing
 * secret, unparseable or stale timestamp, bad signature — returns false.
 */
export async function verifySlackRequest(
  body: string,
  headers: SlackHeaders,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  const timestamp = readHeader(headers, "x-slack-request-timestamp");
  const signature = readHeader(headers, "x-slack-signature");
  if (!timestamp || !signature || !secret) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  // Bound replay: Slack's own guidance is a 5-minute window.
  if (Math.abs(now / 1000 - timestampSeconds) > SLACK_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const expected = `v0=${await hmacHex(secret, `v0:${timestamp}:${body}`)}`;
  return timingSafeEqual(signature, expected);
}
