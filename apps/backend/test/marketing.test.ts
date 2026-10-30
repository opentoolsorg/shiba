/**
 * Guards the custom landing page against a Starlight upgrade reclaiming the
 * index route. Builds the Astro site when `apps/web/dist` is missing or older
 * than the page sources, so `pnpm test` does not depend on a prior `pnpm build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

const webRoot = join(import.meta.dirname, "..", "..", "web");
const distRoot = join(webRoot, "dist");
const indexPath = join(distRoot, "index.html");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function landingBuildIsCurrent(): boolean {
  if (!existsSync(indexPath)) return false;
  const builtAt = statSync(indexPath).mtimeMs;
  const config = join(webRoot, "astro.config.mjs");
  return builtAt >= newestMtime(join(webRoot, "src")) && builtAt >= statSync(config).mtimeMs;
}

function ensureLandingBuild(): void {
  if (landingBuildIsCurrent()) return;
  const astroBin = join(webRoot, "node_modules", ".bin", process.platform === "win32" ? "astro.cmd" : "astro");
  const astroConfigHome = mkdtempSync(join(tmpdir(), "shiba-marketing-astro-"));
  let result;
  try {
    result = spawnSync(astroBin, ["build"], {
      cwd: webRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: astroConfigHome,
        XDG_CACHE_HOME: astroConfigHome,
        XDG_DATA_HOME: astroConfigHome,
      },
    });
  } finally {
    rmSync(astroConfigHome, { recursive: true, force: true });
  }
  if (result.status !== 0 || !existsSync(indexPath)) {
    throw new Error(`astro build failed (${result.status ?? "no exit"})`);
  }
}

ensureLandingBuild();

describe("marketing landing page", () => {
  const html = () => readFileSync(indexPath, "utf-8");

  test("renders the custom landing page, not the Starlight splash", () => {
    const markup = html();
    expect(markup).toContain("Shiba: open-source, self-hosted Devin-style coding agent");
    expect(markup).toContain("pnpm shiba dev");
    // Hero headline as shipped: it asks before it writes code.
    expect(markup).toContain("It asks before");
    expect(markup).toContain("it writes code.");
    expect(markup).toContain("Approval before execution");
    expect(markup).toContain("shiba.workspace");
    expect(markup).not.toContain("manga-panel");
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain("theme-toggle-btn");
    expect(markup).toContain("AGPL-3.0");
    for (const harness of ["OpenCode", "Claude Code", "Codex", "Devin CLI"]) {
      expect(markup).toContain(harness);
    }
  });

  test("every referenced asset exists in the build output", () => {
    const refs = [...html().matchAll(/\/assets\/[\w-]+\/[\w.-]+/g)].map((match) => match[0]);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((ref) => !existsSync(join(distRoot, ref.replace(/^\//, ""))));
    expect(missing).toEqual([]);
  });

  test("carries no Capy branding or scraped assets", () => {
    expect(html().toLowerCase()).not.toContain("capy");
  });
});
