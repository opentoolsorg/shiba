export type NavigationDecision = "allow" | "external" | "deny";

// host or host/path-prefix hops a hosted IdP login needs (D6).
export const DEFAULT_AUTH_HOSTS = [
  "accounts.google.com",
  "github.com/login",
  "github.com/session",
  "login.microsoftonline.com",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function tryParse(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** Origin of any parseable URL, or "" — config.json comparisons, not trust decisions. */
export function originOf(url: string | undefined): string {
  return (url && tryParse(url)?.origin) || "";
}

/** Returns the origin of a valid deployment URL, or null. http is loopback-only and never packaged. */
export function parseDeploymentUrl(input: string, isPackaged: boolean): string | null {
  const url = tryParse(input.trim());
  if (!url || url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && !isPackaged && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

function matchesAuthHost(url: URL, entry: string): boolean {
  const slash = entry.indexOf("/");
  const host = slash === -1 ? entry : entry.slice(0, slash);
  if (url.hostname !== host) return false;
  if (slash === -1) return true;
  const prefix = entry.slice(slash);
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

export function decideNavigation(
  target: string,
  configuredOrigin: string,
  authHosts: readonly string[] = DEFAULT_AUTH_HOSTS,
): NavigationDecision {
  const url = tryParse(target);
  if (!url) return "deny";
  if (configuredOrigin && url.origin === configuredOrigin) return "allow";
  if (url.protocol !== "https:") return "deny";
  if (url.hostname.endsWith(".cloudflareaccess.com")) return "allow";
  if (authHosts.some((entry) => matchesAuthHost(url, entry))) return "allow";
  return "external";
}

/** IPC gate (D4): only frames on the configured origin may call privileged handlers. */
export function isTrustedSender(senderFrameUrl: string | undefined, configuredOrigin: string): boolean {
  if (!senderFrameUrl || !configuredOrigin) return false;
  return tryParse(senderFrameUrl)?.origin === configuredOrigin;
}

/** Setup-only IPC gate: the frame must be the bundled setup page itself (file: origins are opaque, so compare paths). */
export function isSetupSender(senderFrameUrl: string | undefined, setupFileUrl: string): boolean {
  const url = senderFrameUrl ? tryParse(senderFrameUrl) : null;
  const setup = tryParse(setupFileUrl);
  return !!url && !!setup && url.protocol === "file:" && setup.protocol === "file:" && url.pathname === setup.pathname;
}
