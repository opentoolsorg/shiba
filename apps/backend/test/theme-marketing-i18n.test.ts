import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("theme, docs, marketing, and mascot specifications", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const marketingPath = join(root, "apps", "web", "src", "layouts", "MarketingPage.astro");
  const themeProviderPath = join(root, "apps", "frontend", "src", "components", "ThemeProvider.tsx");
  const homePath = join(root, "apps", "web", "src", "pages", "index.astro");
  const landingCssPath = join(root, "apps", "web", "src", "styles", "landing.css");
  const docsThemePath = join(root, "apps", "web", "src", "styles", "theme.css");

  it("shares consistent theme preference key across frontend app and web/astro", () => {
    const tpContent = readFileSync(themeProviderPath, "utf-8");
    const mpContent = readFileSync(marketingPath, "utf-8");

    // The storage key and the system default are a cross-surface contract:
    // renaming either on one side silently splits the theme. The literal is
    // the contract here, not incidental copy.
    expect(tpContent).toContain('shiba-theme');
    expect(mpContent).toContain('shiba-theme');
    expect(tpContent).toContain('defaultTheme="system"');
    expect(mpContent).toContain("root.dataset.themePreference = manual ? 'manual' : 'system'");
  });

  it("has dark-first fallback and dark mode support in MarketingPage and ThemeProvider", () => {
    const mpContent = readFileSync(marketingPath, "utf-8");
    expect(mpContent).toContain("data-theme");
    expect(mpContent).toContain("theme-toggle-btn");

    const docsTheme = readFileSync(docsThemePath, "utf-8");
    // Quote style is incidental; the selector contract is not.
    expect(docsTheme).toMatch(/:root\[data-theme=["']dark["']\]/);
  });

  it("respects prefers-reduced-motion in landing animations", () => {
    const landingCss = readFileSync(landingCssPath, "utf-8");
    expect(landingCss).toContain("prefers-reduced-motion");
  });

  it("names the product's two structural claims — approval gate and the Cloudflare substrate", () => {
    // Copy rewrites are free; removing the claims themselves is a product
    // change this test exists to flag.
    const homeContent = readFileSync(homePath, "utf-8");
    expect(homeContent).toMatch(/approv/i);
    expect(homeContent).toMatch(/cloudflare/i);
  });
});
