function isPrivateIpv4(part: number[]): boolean {
  if (part.length !== 4) return false;
  if (part[0] === 10) return true;
  if (part[0] === 127) return true;
  if (part[0] === 169 && part[1] === 254) return true;
  const second = part[1];
  if (part[0] === 172 && second !== undefined && second >= 16 && second <= 31) return true;
  if (part[0] === 192 && part[1] === 168) return true;
  return false;
}

/** Deny link-local, loopback, and metadata hosts for browser egress. */
export function assertPublicBrowserUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    throw new Error("Local hosts are not allowed.");
  }
  if (host === "[::1]" || host.includes(":")) {
    throw new Error("IPv6 destinations are not allowed.");
  }
  const parts = host.split(".").map((p) => Number(p));
  if (parts.every((n) => Number.isInteger(n))) {
    if (isPrivateIpv4(parts)) throw new Error("Private network hosts are not allowed.");
  }
  if (host === "metadata.google.internal" || host === "169.254.169.254") {
    throw new Error("Metadata hosts are not allowed.");
  }
  return url;
}

export function selectorRequiresSubmitApproval(selector: string, text?: string): boolean {
  const lower = selector.toLowerCase();
  if (lower.includes("password") || lower.includes('type="password"')) return true;
  if (lower.includes("submit") || lower.includes("[type=submit]")) return true;
  if (text !== undefined && /password/i.test(text)) return true;
  return false;
}