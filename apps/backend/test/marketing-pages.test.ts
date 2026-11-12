import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_MCP_VENDORS, INTEGRATION_CATALOG } from "@shiba/shared";
import { SKILL_LIBRARY } from "../src/skill-library/index.js";

// These read apps/web's *built* output — they only have meaning after
// `pnpm build`. CI runs them via `pnpm test:built` as a post-build step;
// the skip keeps `pnpm test` (which runs before dist exists) green
// locally instead of failing on a stale or absent build.
const root = join(import.meta.dirname, "..", "..", "web", "dist");
const built = existsSync(join(root, "waitlist", "index.html"));

describe.skipIf(!built)("new marketing pages", () => {
  const page = (path: string) => readFileSync(join(root, path), "utf8");

  it("replaces the shared header self-host CTA with the canonical GitHub stars link", () => {
    for (const route of ["index.html", "why-shiba/index.html", "integrations/index.html", "waitlist/index.html", "blog/index.html"]) {
      const html = page(route);
      const header = html.split("<header")[1]?.split("</header>")[0] ?? "";
      expect(header).toContain("data-github-stars");
      expect(header).toContain('href="https://github.com/opentoolsorg/shiba"');
      expect(header).toContain('aria-label="Star Shiba on GitHub"');
      expect(header).toMatch(/data-github-stars-count[^>]*>Star<\/span>/);
      expect(header).not.toContain("Self-host");
      expect(header).not.toContain("/docs/self-hosting/");
      // No fabricated build-time star count: the client enhances this useful link.
      expect(header).not.toMatch(/data-github-stars-count[^>]*>\d/);
      expect(html).toContain('href="/docs/self-hosting/"');
    }
  });

  it("lists the app catalog, MCP presets and skill library without claiming connected accounts", () => {
    const html = page("integrations/index.html");
    for (const entry of [...INTEGRATION_CATALOG, ...CURATED_MCP_VENDORS, ...SKILL_LIBRARY]) {
      expect(html).toContain(entry.name.replaceAll("&", "&amp;"));
    }
    for (const section of ["app-catalog", "mcp-presets", "skill-templates"]) {
      expect(html).toContain(`href="#${section}"`);
      expect(html).toContain(`id="${section}"`);
    }
    expect(html).toContain(`${INTEGRATION_CATALOG.length} app entries`);
    expect(html).toContain(`${CURATED_MCP_VENDORS.length} MCP presets`);
    expect(html).toContain(`${SKILL_LIBRARY.length} skill templates`);
    expect(html).toContain("Catalog entries, not connected accounts.");
    expect(html).toContain("Skills do not connect accounts.");
    expect(html).toContain("No automatic execution or publishing.");
  });

  it("publishes distinct, canonical and indexable story and signup pages with light and dark theme support", () => {
    const why = page("why-shiba/index.html");
    const waitlist = page("waitlist/index.html");
    expect(why).toContain('href="https://tryshiba.dev/why-shiba/"');
    expect(waitlist).toContain('href="https://tryshiba.dev/waitlist/"');
    expect(why).toContain("Choosing a tool");
    expect(why).not.toMatch(/cloudroom/i);
    expect(waitlist).toContain('id="waitlist-form"');
    expect(waitlist).toContain('name="consent"');
    expect(waitlist).toContain('name="interest"');
    expect(waitlist).toContain("/api/waitlist");
    // Theme toggle support
    expect(waitlist).toContain("theme-toggle-btn");
    expect(why).toContain("theme-toggle-btn");
    expect(waitlist).toContain("shiba-theme");
    // Founder-voice narrative body copy, not just layout chrome.
    expect(why).toContain("I wanted background execution");
    expect(why).toContain("AGPL-3.0-only");
  });
});
