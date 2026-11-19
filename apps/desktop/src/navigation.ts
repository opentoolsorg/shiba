import { hasControlChars } from "./safe-text.js";

export type NavigationDecision = "allow" | "external" | "deny";

// host or host/path-prefix hops a hosted IdP login needs (D6).
export const DEFAULT_AUTH_HOSTS = [
  "accounts.google.com",
  "slack.com/openid/connect",
  "github.com/login",
  "github.com/session",
  "login.microsoftonline.com",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
const MAX_URL_CHARS = 2048;
/** Dashboard tabs a native surface may load — the same set the tray and deep links use. */
const APP_TABS = new Set(["tasks", "diff", "approvals", "providers", "remote", "activity"]);

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
  if (!url || url.username || url.password) return "deny";
  if (configuredOrigin && url.origin === configuredOrigin) return "allow";
  if (url.protocol !== "https:") return "deny";
  if (url.hostname.endsWith(".cloudflareaccess.com")) return "allow";
  if (authHosts.some((entry) => matchesAuthHost(url, entry))) return "allow";
  return "external";
}

/**
 * The URL (if any) a main-frame navigation may hand to the OS browser: an
 * uncredentialed https link that is neither the app itself nor an in-app auth
 * host. Returns the normalized href, so the caller never passes raw input on.
 */
export function externalHandoffUrl(
  target: string,
  configuredOrigin: string,
  authHosts: readonly string[] = DEFAULT_AUTH_HOSTS,
): string | null {
  if (target.length === 0 || target.length > MAX_URL_CHARS) return null;
  const decision = decideNavigation(target, configuredOrigin, authHosts);
  if (decision !== "external") return null;
  const url = tryParse(target);
  if (!url || url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  return url.toString();
}

/** An https URL on an allowed sign-in host; only a popup may be handed over this way. */
export function authHostUrl(
  target: string,
  authHosts: readonly string[] = DEFAULT_AUTH_HOSTS,
): string | null {
  if (target.length === 0 || target.length > MAX_URL_CHARS) return null;
  const url = tryParse(target);
  if (!url || url.protocol !== "https:" || url.username || url.password) return null;
  if (url.origin === "" || !authHosts.some((entry) => matchesAuthHost(url, entry))) return null;
  return url.toString();
}

/**
 * Subframes stay on the app's own origin. The dashboard embeds same-origin,
 * sandboxed previews; nothing else may navigate a frame inside the shell.
 */
export function isSubframeNavigationAllowed(
  target: string,
  configuredOrigin: string,
): boolean {
  if (!configuredOrigin) return false;
  const url = tryParse(target);
  if (!url || url.username || url.password) return false;
  return url.origin === configuredOrigin;
}

/** An app-internal path the shell may load: `/app/` or `/app/?tab=<known tab>`. */
export function isSafeAppPath(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (hasControlChars(value) || /\s|\\/.test(value)) return false;
  if (value === "/app/") return true;
  if (!value.startsWith("/app/?tab=")) return false;
  return APP_TABS.has(value.slice("/app/?tab=".length));
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
