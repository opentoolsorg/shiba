import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import {
  primeThemeStorage,
  readSharedThemePreference,
  sharedThemeCookie,
} from "./theme-preference";

function ThemeCookieBridge() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const syncFromCookie = () => {
      const shared = readSharedThemePreference(document.cookie);
      if (shared && shared !== theme) setTheme(shared);
    };
    const syncToCookie = () => {
      const themeColor = document.querySelector('meta[name="theme-color"]');
      if (themeColor) themeColor.setAttribute("content", resolvedTheme === "dark" ? "#09090b" : "#fafafa");
      if (theme === "light" || theme === "dark" || theme === "system") {
        // biome-ignore lint/suspicious/noDocumentCookie: the shared cookie is the cross-subdomain channel; Cookie Store API support is not universal.
        document.cookie = sharedThemeCookie(theme, location.hostname, location.protocol);
      }
    };
    syncToCookie();
    window.addEventListener("focus", syncFromCookie);
    document.addEventListener("visibilitychange", syncFromCookie);
    return () => {
      window.removeEventListener("focus", syncFromCookie);
      document.removeEventListener("visibilitychange", syncFromCookie);
    };
  }, [theme, resolvedTheme, setTheme]);

  return null;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  // Once, before NextThemesProvider reads storage; later renders must not
  // overwrite a newer local choice with a stale cookie.
  useState(() => {
    if (typeof document === "undefined") return;
    try {
      primeThemeStorage(document.cookie, localStorage);
    } catch {
      // Keep rendering when browser storage is unavailable.
    }
  });

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="shiba-theme"
      themes={["dark", "light"]}
    >
      <ThemeCookieBridge />
      {children}
    </NextThemesProvider>
  );
}

export { useTheme };
