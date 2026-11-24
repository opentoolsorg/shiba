import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  primeThemeStorage,
  readSharedThemePreference,
  sharedThemeCookie,
} from "./theme-preference";

const rootRoute = readFileSync(new URL("../routes/__root.tsx", import.meta.url), "utf8");
const themeBootstrapScript = readFileSync(new URL("../../public/assets/theme-bootstrap.js", import.meta.url), "utf8");

describe("shared theme preference", () => {
  it("applies the saved dashboard theme before first paint", () => {
    expect(rootRoute).toContain('src="/assets/theme-bootstrap.js"');
    expect(rootRoute).not.toContain('className="dark"');
  });
  it("reads only supported cookie values", () => {
    expect(readSharedThemePreference("other=x; shiba-theme=dark; Path=/")).toBe("dark");
    expect(readSharedThemePreference("shiba-theme=system")).toBe("system");
    expect(readSharedThemePreference("shiba-theme=auto")).toBeNull();
    expect(readSharedThemePreference("shiba-theme=darkness")).toBeNull();
    expect(readSharedThemePreference("xshiba-theme=dark")).toBeNull();
    expect(readSharedThemePreference("")).toBeNull();
  });

  it("writes a secure parent-domain cookie only on Shiba hosts", () => {
    expect(sharedThemeCookie("dark", "app.tryshiba.dev", "https:")).toBe(
      "shiba-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.tryshiba.dev; Secure",
    );
    expect(sharedThemeCookie("light", "tryshiba.dev", "https:")).toContain("Domain=.tryshiba.dev");
    expect(sharedThemeCookie("light", "localhost", "http:")).not.toContain("Domain=");
    expect(sharedThemeCookie("system", "localhost", "http:")).not.toContain("Secure");
    expect(sharedThemeCookie("dark", "eviltryshiba.dev", "https:")).not.toContain("Domain=");
    expect(sharedThemeCookie("dark", "tryshiba.dev.evil.com", "https:")).not.toContain("Domain=");
  });

  it("primes local theme storage from a shared preference", () => {
    const values = new Map<string, string>();
    const preference = primeThemeStorage("shiba-theme=light", {
      setItem: (key, value) => values.set(key, value),
    });
    expect(preference).toBe("light");
    expect(values.get("shiba-theme")).toBe("light");
  });

  it("leaves local theme storage alone when the cookie is missing or invalid", () => {
    const values = new Map<string, string>([["shiba-theme", "dark"]]);
    const storage = { setItem: (key: string, value: string) => values.set(key, value) };
    expect(primeThemeStorage("", storage)).toBeNull();
    expect(primeThemeStorage("shiba-theme=auto", storage)).toBeNull();
    expect(values.get("shiba-theme")).toBe("dark");
  });

  it("sets dashboard appearance before paint from shared, saved, or system preference", () => {
    const boot = (cookie: string, stored: string | null, systemDark: boolean) => {
      const classes = new Set<string>();
      const themeMeta: { content: string; setAttribute: (name: string, value: string) => void } = {
        content: "",
        setAttribute(_name, value) { this.content = value; },
      };
      const values = new Map(stored ? [["shiba-theme", stored]] : []);
      const document = {
        cookie,
        documentElement: {
          style: {} as Record<string, string>,
          classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
        },
        querySelector: () => themeMeta,
      };
      runInNewContext(themeBootstrapScript, {
        document,
        localStorage: { setItem: (key: string, value: string) => values.set(key, value), getItem: (key: string) => values.get(key) ?? null },
        matchMedia: () => ({ matches: systemDark }),
      });
      return { classes, themeMeta, values, document };
    };
    const light = boot("shiba-theme=light", "dark", true);
    expect(light.classes.has("dark")).toBe(false);
    expect(light.document.documentElement.style.colorScheme).toBe("light");
    expect(light.themeMeta.content).toBe("#fafafa");
    expect(light.values.get("shiba-theme")).toBe("light");
    expect(boot("", null, true).classes.has("dark")).toBe(true);
    expect(boot("", null, false).classes.has("dark")).toBe(false);
  });
});
