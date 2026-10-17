/**
 * Post-sign-in return path. The Worker sends a signed-out browser on the
 * OAuth consent screen to `/?next=/oauth/authorize?...`; only that path is
 * honoured, so `next` can never become an open redirect.
 */
export function signInReturnPath(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  if (next === null) return null;
  return /^\/oauth\/authorize(?:\?|$)/.test(next) ? next : null;
}
