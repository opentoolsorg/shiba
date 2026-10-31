/**
 * Pure security helpers. Dependency-free so they run in the Worker,
 * in Vitest, and anywhere else without modification.
 */

export const GITHUB_HOST = "github.com";
export const MAX_REPO_URL_LENGTH = 2048;
export const MAX_RUNNER_URL_LENGTH = 1024;

export class InputError extends Error {
  readonly code = "input_error";
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * An input error whose answer is "missing" rather than "malformed" —
 * carries the 404 through DO-to-worker plumbing that otherwise flattens
 * every failure to a 400.
 */
export class NotFoundError extends InputError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

const GITHUB_REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/** Canonical GitHub owner or repository name — safe as a single URL path segment. */
export function parseGitHubRepoSegment(raw: string, label: "owner" | "repository"): string {
  if (typeof raw !== "string" || raw === "" || raw === "." || raw === ".." || !GITHUB_REPO_SEGMENT_RE.test(raw)) {
    throw new InputError(`Invalid GitHub ${label} name.`);
  }
  return raw;
}

/** Positive integer pull number for merge/review APIs. */
export function parseGitHubPullNumber(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new InputError("Pull request number must be a positive integer.");
  }
  return raw;
}

/**
 * Accept only HTTPS GitHub repository URLs. Anything else throws.
 * Returned names are validated against GitHub's naming rules so they are
 * safe to reuse in API paths and branch names.
 */
export function parseGitHubRepoUrl(raw: string): GitHubRepo {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REPO_URL_LENGTH) {
    throw new InputError("Repository URL must be a non-empty string.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InputError("Repository URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new InputError("Repository URL must use HTTPS.");
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST) {
    throw new InputError("Repository URL must point to github.com.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new InputError("Repository URL must not embed credentials.");
  }
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new InputError("Repository URL must look like https://github.com/owner/repo.");
  }
  const owner = segments[0] as string;
  let repo = segments[1] as string;
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  return { owner: parseGitHubRepoSegment(owner, "owner"), repo: parseGitHubRepoSegment(repo, "repository") };
}

/**
 * Shell quoting moved to @shiba/shared (security.ts) so packages/auth's
 * antigravity provider builds sandbox commands without app imports.
 */
export { shellJoin, shellQuote } from "@shiba/shared";

/**
 * Deterministic, DNS-safe sandbox name from repo URL, task, and a nonce.
 * Lowercase alphanumerics and hyphens only, capped at 63 characters so the
 * value is safe as a Durable Object id, container label, and directory name.
 */
export function makeSandboxId(repoUrl: string, task: string, nonce: string): string {
  const digest = cyrb53(`${repoUrl}\n${task}\n${nonce}`);
  return `run-${digest}`;
}

/** 53-bit hash rendered as 14 lowercase hex chars. Pure and deterministic. */
export function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const upper = (h2 >>> 0).toString(16).padStart(8, "0");
  const lower = (h1 >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return `${upper}${lower}`.toLowerCase();
}

// The scrubber lives in @shiba/shared so packages/ code can redact too;
// re-exported so existing `./security.js` imports are unchanged.
export { redactSecrets } from "@shiba/shared";

/** Keep the tail of a log bounded, with a marker when truncated. */
export function boundTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `…[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

/**
 * Constant-time string equality — for bearer-token compares where
 * crypto.subtle.timingSafeEqual is not in the runtime's type surface.
 * Lengths are compared first; a length mismatch rejects before the loop
 * so no prefix information leaks.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature (`sha256=<hex>`) with a
 * timing-safe comparison. Uses WebCrypto so it runs in Workers and Node.
 */
export async function verifyGitHubWebhookSignature(args: {
  secret: string;
  payload: string;
  signature: string | null;
}): Promise<boolean> {
  const { secret, payload, signature } = args;
  if (!secret || !signature || !signature.startsWith("sha256=")) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const actual = signature.slice("sha256=".length).toLowerCase();
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").trim();
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return true;
  }
  // IPv4 dotted quad check
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts.some((p) => p < 0 || p > 255)) return true;
    const [b0, b1] = parts as [number, number, number, number];
    // 0.0.0.0/8
    if (b0 === 0) return true;
    // 10.0.0.0/8
    if (b0 === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (private)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (private)
    if (b0 === 192 && b1 === 168) return true;
    // Broadcast / CGNAT (100.64.0.0/10)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  }
  // IPv6 checks
  if (
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "::" ||
    host.startsWith("fe80:") || // link-local
    host.startsWith("::ffff:") || // IPv4-mapped
    (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd"))) // unique local
  ) {
    return true;
  }
  return false;
}

export function validateRunnerUrl(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError("Runner URL must be a non-empty string.");
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_RUNNER_URL_LENGTH) {
    throw new InputError(`Runner URL must be at most ${MAX_RUNNER_URL_LENGTH} characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InputError("Runner URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new InputError("Runner URL must use HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InputError("Runner URL must not embed credentials.");
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new InputError("Runner URL must not point to private, loopback, or link-local hosts.");
  }
  return parsed.origin;
}
