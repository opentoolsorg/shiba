/**
 * `/api/sentry/webhook` — Sentry issue-alert intake. The alert resolves to a
 * queued run through the same approval gate as every other automation: the
 * endpoint verifies Sentry's shared secret, dedupes by event id through the
 * Automations DO, and hands the DO a fix task carrying the issue title, the
 * top stack frames, and the issue permalink. Nothing auto-executes.
 *
 * Verification accepts either lane Sentry operators actually configure:
 * `sentry-hook-signature` (HMAC-SHA256 of the raw body keyed by the client
 * secret) or the `x-sentry-token` shared-secret header (authorization:
 * Bearer is honored as the same token).
 */
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";
import { parseGitHubRepoUrl, redactSecrets, timingSafeEqualString } from "./security.js";

export const SENTRY_WEBHOOK_PATH = "/api/sentry/webhook";

interface SentryIssueAlert {
  title: string;
  stackTop: string;
  permalink?: string;
  eventId: string;
  repoUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Hex-encode an ArrayBuffer. Kept local so the file does not grow a
 * dependency on the GitHub module's private helper.
 */
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256(secret, payload) as lowercase hex — the Sentry hook signature. */
async function sentrySignature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hex(mac);
}

/**
 * Verify the delivery. `sentry-hook-signature` (bare hex HMAC-SHA256 of the
 * raw body) wins when present; otherwise the `x-sentry-token` header or an
 * `authorization: Bearer` token must equal the secret, compared in constant
 * time. Anything else is a 401.
 */
async function verifySentryDelivery(request: Request, secret: string, payload: string): Promise<boolean> {
  const signature = request.headers.get("sentry-hook-signature");
  if (signature && signature.trim() !== "") {
    const expected = await sentrySignature(secret, payload);
    const presented = signature.trim().replace(/^sha256=/i, "").toLowerCase();
    return timingSafeEqualString(presented, expected);
  }
  const tokenHeader = request.headers.get("x-sentry-token") ?? "";
  const bearer = request.headers.get("authorization") ?? "";
  const presented =
    tokenHeader.trim() !== ""
      ? tokenHeader.trim()
      : bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice("bearer ".length).trim()
        : "";
  return presented !== "" && timingSafeEqualString(presented, secret);
}

/**
 * Pull the stable event identity out of an issue-alert payload. Sentry
 * alert bodies carry it as `data.event.event_id` (issue alerts) or
 * `data.issue.id`; fall back to the top-level `id`.
 */
function sentryEventId(body: Record<string, unknown>): string | null {
  const data = asRecord(body.data);
  const event = asRecord(data.event);
  const issue = asRecord(data.issue);
  const candidates = [event.event_id, issue.id, body.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

/** Best-effort top frames from a Sentry exception payload, bounded. */
function sentryStackTop(body: Record<string, unknown>): string {
  const data = asRecord(body.data);
  const event = asRecord(data.event);
  const exception = asRecord(event.exception);
  const values = Array.isArray(exception.values) ? exception.values : [];
  const lines: string[] = [];
  for (const entry of values) {
    const value = asRecord(entry);
    const type = typeof value.type === "string" ? value.type : "Error";
    const message = typeof value.value === "string" ? value.value : "";
    lines.push(message !== "" ? `${type}: ${message}` : type);
    const stacktrace = asRecord(value.stacktrace);
    const frames = Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
    // Sentry serializes frames oldest-first; the throwing frame is last.
    for (const frame of frames.slice(-3)) {
      const f = asRecord(frame);
      const fn = typeof f.function === "string" ? f.function : "<anonymous>";
      const file = typeof f.filename === "string" ? f.filename : typeof f.abs_path === "string" ? f.abs_path : "?";
      const line = typeof f.lineno === "number" ? `:${f.lineno}` : "";
      lines.push(`  at ${fn} (${file}${line})`);
    }
    if (lines.length >= 12) break;
  }
  const rendered = lines.join("\n");
  return rendered.length > 1500 ? rendered.slice(0, 1500) : rendered;
}

/**
 * Normalize a Sentry issue-alert body into the fields the fix task needs.
 * Returns null when the payload cannot name an issue — alerts without a
 * title or event id are not runnable work.
 */
export function sentryAlertToIntake(body: unknown): SentryIssueAlert | null {
  const record = asRecord(body);
  const data = asRecord(record.data);
  const issue = asRecord(data.issue);
  const event = asRecord(data.event);
  const title =
    typeof issue.title === "string" && issue.title.trim() !== ""
      ? issue.title.trim()
      : typeof event.title === "string" && event.title.trim() !== ""
        ? event.title.trim()
        : typeof record.title === "string" && record.title.trim() !== ""
          ? record.title.trim()
          : null;
  const eventId = sentryEventId(record);
  if (!title || !eventId) return null;
  const issueTitle = asRecord(issue.metadata).title;
  const permalink =
    typeof issue.permalink === "string"
      ? issue.permalink
      : typeof event.web_url === "string"
        ? event.web_url
        : typeof record.url === "string"
          ? record.url
          : typeof issueTitle === "string"
            ? undefined
            : undefined;
  const repoCandidate =
    typeof record.repoUrl === "string"
      ? record.repoUrl
      : typeof data.repoUrl === "string"
        ? data.repoUrl
        : undefined;
  return {
    title,
    stackTop: sentryStackTop(record),
    ...(permalink !== undefined ? { permalink } : {}),
    eventId,
    ...(repoCandidate !== undefined ? { repoUrl: repoCandidate } : {}),
  };
}

export async function handleSentryWebhook(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SENTRY_WEBHOOK_PATH) {
    return null;
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const secret = env.SENTRY_WEBHOOK_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Sentry intake is not configured: set the SENTRY_WEBHOOK_SECRET secret." },
      { status: 503 },
    );
  }
  const payload = await request.text();
  const valid = await verifySentryDelivery(request, secret, payload);
  if (!valid) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Webhook payload is not valid JSON." }, { status: 400 });
  }
  const intake = sentryAlertToIntake(body);
  if (intake === null) {
    // Unrelated resources (metric alerts, install pings) are acknowledged so
    // Sentry does not retry them forever; they are never queued.
    return Response.json({ ok: true, ignored: true });
  }
  const repoUrl = intake.repoUrl ?? env.SENTRY_REPO_URL ?? "";
  if (repoUrl === "") {
    return Response.json(
      { error: "No repository for the alert: set SENTRY_REPO_URL or include repoUrl in the payload." },
      { status: 503 },
    );
  }
  try {
    parseGitHubRepoUrl(repoUrl);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Repository URL is invalid." },
      { status: 400 },
    );
  }
  // Dedupe BEFORE queueing: Sentry retries on non-2xx, so a recorded key is
  // the only guard against a duplicate fix run. Same fail-closed posture as
  // the GitHub lane — a dedupe outage is a retryable 503, never a silent
  // double-run.
  try {
    const seen = await automationsStub(env).fetch(
      new Request("https://internal/internal/dedupe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: `sentry-event:${intake.eventId.slice(0, 120)}` }),
      }),
    );
    if (!seen.ok) {
      throw new Error(`dedupe endpoint returned ${seen.status}`);
    }
    const seenBody = (await seen.json().catch(() => ({}))) as { seen?: boolean };
    if (seenBody.seen === true) {
      return Response.json({ ok: true, deduped: true });
    }
  } catch (error: unknown) {
    console.error(
      `sentry delivery dedupe failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return Response.json({ error: "Delivery dedupe unavailable; retry." }, { status: 503 });
  }
  const taskLines = [
    "Fix the Sentry issue below. Reproduce the failure, land the smallest correct fix, and explain the root cause.",
    `Sentry issue: ${intake.title}`,
    ...(intake.permalink ? [`Permalink: ${intake.permalink}`] : []),
    `Event: ${intake.eventId}`,
    ...(intake.stackTop !== "" ? ["", "Top frames:", intake.stackTop] : []),
  ];
  const queued = await automationsStub(env).fetch(
    new Request("https://internal/internal/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl,
        task: taskLines.join("\n"),
        eventId: intake.eventId,
      }),
    }),
  );
  if (!queued.ok) {
    const detail = await queued.text().catch(() => "");
    console.error(`sentry queue failed: ${queued.status} ${redactSecrets(detail.slice(0, 300))}`);
    return Response.json({ error: "Could not queue the fix run; retry." }, { status: 502 });
  }
  const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string };
  return Response.json({ ok: true, approvalId: queuedBody.approvalId ?? null });
}
