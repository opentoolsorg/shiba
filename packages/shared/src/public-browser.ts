import { z } from "zod";

/** Separate default-off public browsing mode; never a reinterpretation of shiba.offline-computer.v1. */
export const PUBLIC_BROWSER_POLICY = "shiba.public-browser.v1";
export const PUBLIC_BROWSER_LIMITS = {
  ttlMs: 600_000,
  maxRequests: 100,
  maxResponseBytes: 2_097_152,
  maxTotalResponseBytes: 10_485_760,
  maxUrlLength: 2048,
  maxQueryValueLength: 128,
  maxTargets: 8,
} as const;
const RESERVED_SUFFIXES = new Set(["localhost", "local", "internal", "arpa", "invalid", "onion", "lan", "home", "corp", "intranet"]);
// Exact lowercase ASCII (punycode) hostnames only: no wildcard, IP literal, port, userinfo or trailing dot.
const host = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/)
  .refine((value) => !RESERVED_SUFFIXES.has(value.split(".").at(-1)!), "Reserved host suffix.");
const pathPrefix = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~/-]*$/)
  .refine((value) => !value.includes("//") && !/(?:^|\/)\.\.?(?:\/|$)/.test(value), "Ambiguous path prefix.");
export const publicBrowserTargetSchema = z
  .object({
    host,
    pathPrefixes: z.array(pathPrefix).min(1).max(8),
    queryKeys: z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/)).max(8),
    navigate: z.boolean(),
    subresources: z.boolean(),
  })
  .strict();
export type PublicBrowserTarget = z.infer<typeof publicBrowserTargetSchema>;
export type PublicBrowserRequestMode = "navigate" | "subresource";

/** One canonicalization for review and dispatch. Ambiguous input is refused, not repaired. */
export function matchPublicBrowserUrl(targets: readonly PublicBrowserTarget[], raw: string, mode: PublicBrowserRequestMode) {
  if (raw.length > PUBLIC_BROWSER_LIMITS.maxUrlLength || /[\s\\]/.test(raw) || /%(?:2f|5c|2e|00|25)/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  const target = targets.find((candidate) => candidate.host === url.hostname);
  if (!target || !(mode === "navigate" ? target.navigate : target.subresources)) return null;
  const path = url.pathname;
  if (!target.pathPrefixes.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)))) return null;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !target.queryKeys.includes(key))) return null;
  if ([...url.searchParams.values()].some((value) => value.length > PUBLIC_BROWSER_LIMITS.maxQueryValueLength)) return null;
  return { url, target };
}

export const publicBrowserManifestSchema = z
  .object({
    policy: z.literal(PUBLIC_BROWSER_POLICY),
    catalogRevision: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    startUrl: z.string().max(PUBLIC_BROWSER_LIMITS.maxUrlLength),
    targets: z.array(publicBrowserTargetSchema).min(1).max(PUBLIC_BROWSER_LIMITS.maxTargets),
  })
  .strict()
  .refine((value) => new Set(value.targets.map((target) => target.host)).size === value.targets.length, "Hosts must be distinct.")
  .refine((value) => matchPublicBrowserUrl(value.targets, value.startUrl, "navigate") !== null, "Start URL must be an approved navigation target.");
export type PublicBrowserManifest = z.infer<typeof publicBrowserManifestSchema>;
