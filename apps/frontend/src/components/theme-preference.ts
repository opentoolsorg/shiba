export type ThemePreference = "light" | "dark" | "system";
const COOKIE = "shiba-theme";

// The blocking pre-paint selector lives in public/assets/theme-bootstrap.js.

export function readSharedThemePreference(cookie: string): ThemePreference | null {
  const value = cookie.match(/(?:^|;\s*)shiba-theme=(light|dark|system)(?:;|$)/)?.[1];
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export function sharedThemeCookie(
  preference: ThemePreference,
  hostname: string,
  protocol: string,
): string {
  const domain =
    hostname === "tryshiba.dev" || hostname.endsWith(".tryshiba.dev")
      ? "; Domain=.tryshiba.dev"
      : "";
  const secure = protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
}

export function primeThemeStorage(
  cookie: string,
  storage: Pick<Storage, "setItem">,
): ThemePreference | null {
  const preference = readSharedThemePreference(cookie);
  if (preference) storage.setItem(COOKIE, preference);
  return preference;
}
