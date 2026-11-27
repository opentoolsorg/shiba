import type { DesktopViewName } from "@shiba/shared";

/** Hosted product the packaged app signs in to when no self-hosted URL is saved. */
export const HOSTED_ORIGIN = "https://app.tryshiba.dev";

export const DESKTOP_VIEWS: readonly DesktopViewName[] = [
  "work",
  "dashboard",
  "tasks",
  "threads",
  "activity",
  "analytics",
  "diff",
  "approvals",
  "swarm",
  "collaboration",
  "team",
  "agents",
  "inbox",
  "memory",
  "files",
  "notes",
  "projects",
  "outputs",
  "automations",
  "providers",
  "integrations",
  "skills",
  "spaces",
  "custom-agents",
  "employee-tools",
  "chief-of-staff",
  "remote",
  "settings",
];

/**
 * An interactive selection wins for the rest of this process.
 * At launch, unpackaged `SHIBA_DESKTOP_URL` wins when it is non-empty.
 * An explicit empty value, or `SHIBA_DESKTOP_SETUP=1`, opens the setup page.
 * Otherwise a saved origin is used, then the hosted product.
 */
export function resolveConfiguredOrigin(input: {
  packaged: boolean;
  /** A URL chosen interactively in this process supersedes launch hints. */
  sessionUrl?: string;
  envUrl: string | undefined;
  forceSetup: boolean;
  savedUrl: string | undefined;
  parse: (value: string, packaged: boolean) => string | null;
}): string {
  if (input.sessionUrl !== undefined) return input.parse(input.sessionUrl, input.packaged) ?? "";
  if (input.forceSetup) return "";
  if (!input.packaged && input.envUrl === "") return "";
  if (!input.packaged && input.envUrl) {
    return input.parse(input.envUrl, false) ?? "";
  }
  const saved = input.savedUrl ? input.parse(input.savedUrl, input.packaged) : null;
  if (saved) return saved;
  // A packaged first launch asks which deployment to connect to instead of
  // silently assuming the hosted product; unpackaged dev keeps the hosted
  // default so local runs need no extra click.
  return input.packaged ? "" : HOSTED_ORIGIN;
}

/** Dashboard path for a view. `?run=` is intentionally omitted: the SPA treats it as the thread, not the diff tab. */
export function dashboardPath(view: DesktopViewName): string {
  return `/${view}/`;
}

export function isDesktopView(value: string): value is DesktopViewName {
  return (DESKTOP_VIEWS as readonly string[]).includes(value);
}
