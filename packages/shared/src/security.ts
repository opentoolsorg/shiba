/**
 * Secret-shape scrubbing — pure TypeScript, no Worker or DOM deps, so it
 * lives in shared and every surface (Worker logs, auth flow records,
 * package tooling) redacts with the same pattern set.
 */
const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /ghu_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /AIza[A-Za-z0-9_-]{8,}/g,
  // OpenAI, Anthropic, OpenRouter and the rest of the sk- family: the hyphen
  // separates prefixes (sk-ant-, sk-proj-, sk-or-v1-), so the class includes it.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /aws_secret_access_key\s*[:=]\s*\S{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,

  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{8,}['"]?/gi,
  /AI_GATEWAY_TOKEN\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /"(?:access_token|refresh_token|id_token)"\s*:\s*"[^"]{8,}"/g,
  /\{[^{}]*"tokens"\s*:\s*\{[^{}]*\}[^{}]*\}/g,
  // Org API keys, MCP agent tokens, and OAuth access tokens (KV bearer shapes).
  /\bshk_[0-9a-f]{16}_[0-9a-f]{48}\b/gi,
  /\bshb_[0-9a-f]{16}_[0-9a-f]{48}\b/gi,
  /\bsho_[0-9a-f]{16}_[0-9a-f]{48}\b/gi,
];

/**
 * Credentials embedded in a URL: the scheme and host survive so the text stays
 * readable, the userinfo does not.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi;

/**
 * Replace known secret shapes with [redacted]. Safe to run on any text.
 *
 * This is also a reject gate: six callers store or return text only when it
 * comes back unchanged (Slack report delivery, connector jobs, shared-computer
 * input, local dispatch rows). Every pattern here must therefore be anchored to
 * a credential's own shape — a prefix or a named secret field — never to prose
 * like "Tokens: 1,914,427" or "password: must-be-12-chars-or-longer". Loose
 * assignment matching belongs to the callers that may rewrite freely, such as
 * the context import (see redactContextImportText in apps/backend).
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  URL_USERINFO.lastIndex = 0;
  return out.replace(URL_USERINFO, "$1[redacted]@");
}

/** Quote one shell argument with POSIX single quotes. Never concatenate. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join argv into one shell command string with every argument quoted. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
