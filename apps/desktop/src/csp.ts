/**
 * Defense-in-depth CSP for the dashboard document. Report-Only on purpose: the
 * dashboard's real policy belongs to the Worker that serves /app/, and this
 * shell never overwrites a policy that came back. The injection only exists so
 * a shell-hosted dashboard reports the same violations a browser would, before
 * anyone enforces a server-side policy.
 */

export const DASHBOARD_CSP_REPORT_ONLY = [
  "default-src 'self'",
  // The bundled dashboard is a Vite build; its bootstrap is inline today.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface CspDecisionInput {
  url: string;
  resourceType: string;
  /** Response headers as Electron reports them; keys may be any case. */
  headers: Record<string, string[] | undefined>;
  configuredOrigin: string;
}

function hasHeader(headers: Record<string, string[] | undefined>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted && (headers[key] ?? []).length > 0);
}

/**
 * The policy to add, or null when the shell must stay out of the way: a
 * different origin, a non-document request, or a policy already present.
 */
export function dashboardCspReportOnly(input: CspDecisionInput): string | null {
  if (!input.configuredOrigin) return null;
  if (input.resourceType !== "mainFrame") return null;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (url.origin !== input.configuredOrigin) return null;
  if (hasHeader(input.headers, "content-security-policy")) return null;
  if (hasHeader(input.headers, "content-security-policy-report-only")) return null;
  return DASHBOARD_CSP_REPORT_ONLY;
}
