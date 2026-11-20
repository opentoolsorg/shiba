/**
 * The extension's whole policy, kept free of browser APIs so it is testable
 * without Chrome: which address may leave the tab, which Shiba destination may
 * receive it, and the handoff address itself.
 *
 * The handoff uses the dashboard's existing deep-link contract. The Threads
 * route reads `?prompt=`, prefills the composer with it, strips the parameter
 * from the address and never submits it (`apps/frontend/src/ui-helpers.ts`,
 * `readPromptParam`). Nothing here creates a run, an approval or a provider
 * call; the draft waits in the composer until the person sends it.
 */

export const DESTINATION_KEY = "destination";

/** The dashboard truncates `?prompt=` at 4000 characters before it fills the composer. */
export const DRAFT_LIMIT = 4000;

/** The served dashboard route that consumes `?prompt=`. */
export const HANDOFF_PATH = "/threads/";

export const REASON_MESSAGES = {
  malformed: "That is not a valid web address.",
  "unsupported-address": "Only http and https pages can be sent.",
  "no-tab-access":
    "Shiba cannot read this tab. Click the Shiba toolbar button on the page you want to send.",
  "no-destination": "Set your Shiba dashboard address first.",
  "credentials-not-allowed": "The dashboard address cannot contain a username or password.",
  "origin-only": "Use the dashboard origin alone, such as https://shiba.example.com.",
  "insecure-destination": "Use https, or http only for a localhost address.",
  "empty-draft": "The draft is empty, so there is nothing to open.",
};

function parseAddress(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Reduces a tab address to what may leave the browser: scheme, host and path.
 * Credentials, query and fragment are dropped because they carry tokens,
 * session ids and search terms; a non-web or unparseable address is refused
 * outright instead of being guessed at.
 */
export function sanitizePageUrl(raw) {
  const url = parseAddress(raw);
  if (url === null) return { ok: false, reason: "malformed" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-address" };
  }
  if (url.hostname === "") return { ok: false, reason: "malformed" };
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { ok: true, url: url.toString() };
}

/**
 * Accepts one dashboard origin and nothing else, so a typo cannot point the
 * handoff at a path, an embedded credential or a plaintext remote host.
 * Plain http is allowed only for a loopback address carrying local development.
 */
export function normalizeDestination(raw) {
  const url = parseAddress(raw);
  if (url === null) return { ok: false, reason: "malformed" };
  if (url.protocol === "http:") {
    if (!isLoopbackHost(url.hostname)) return { ok: false, reason: "insecure-destination" };
  } else if (url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-address" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials-not-allowed" };
  }
  if (url.hostname === "") return { ok: false, reason: "malformed" };
  // The parser repairs spellings such as `https:host` or `/dir/..`; the
  // typed text itself must already be a bare origin.
  const typed = raw.trim();
  if (!/^https?:\/\//i.test(typed)) return { ok: false, reason: "malformed" };
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(typed)) return { ok: false, reason: "origin-only" };
  return { ok: true, origin: url.origin };
}

/** Clips at the dashboard's limit without splitting a surrogate pair, which would make the address unencodable. */
function clipDraft(text) {
  if (text.length <= DRAFT_LIMIT) return text;
  const clipped = text.slice(0, DRAFT_LIMIT);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

/** The draft address, or null when the destination is invalid or the draft is blank. */
export function handoffUrl(origin, draft) {
  const destination = normalizeDestination(origin);
  if (!destination.ok) return null;
  const text = typeof draft === "string" ? draft.trim() : "";
  if (text === "") return null;
  return `${destination.origin}${HANDOFF_PATH}?prompt=${encodeURIComponent(clipDraft(text))}`;
}

/** The prompt a handoff address carries, decoded, for the popup's own checks and the tests. */
export function draftFromHandoffUrl(raw) {
  const url = parseAddress(raw);
  if (url === null) return null;
  return url.searchParams.get("prompt");
}
