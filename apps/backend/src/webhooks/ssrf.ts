/**
 * Outbound webhook URL guard — https only, block loopback and private ranges.
 */

const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".workers.dev",
  ".cloudflare.com",
  "cloudflarestorage.com",
];

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

export function validateWebhookDestination(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "Invalid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Webhook URLs must use https." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Webhook URLs must not embed credentials." };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Loopback hosts are not allowed." };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      return { ok: false, reason: "That host is not allowed for outbound webhooks." };
    }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (PRIVATE_V4.some((re) => re.test(host))) {
      return { ok: false, reason: "Private IP addresses are not allowed." };
    }
  }
  if (host.includes(":") && isPrivateIpv6(host)) {
    return { ok: false, reason: "Private IP addresses are not allowed." };
  }
  return { ok: true, url: parsed };
}