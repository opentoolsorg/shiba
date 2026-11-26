import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?tsx?$/.test(path) ? [path] : [];
  });
}

it("keeps Cloudflare Sandbox SDK imports inside its adapter", () => {
  const root = join(import.meta.dirname, "../src");
  const violations: string[] = [];
  // Match static imports, re-exports, dynamic imports, and require calls.
  const sdkImport = /\b(?:(?:import|export)\b\s*(?:[^;"']*?\bfrom\s*)?|(?:import|require)\s*\(\s*)["']@cloudflare\/sandbox(?:\/[^"']*)?["']/g;
  for (const path of sources(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (name.startsWith("adapters/sandbox/cloudflare/")) continue;
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(sdkImport)) {
      const durableObjectExport = name === "index.ts" &&
        /^export\s*\{\s*Sandbox\s*\}\s*from\s*["']@cloudflare\/sandbox["']$/.test(match[0]);
      if (!durableObjectExport) {
        const line = content.slice(0, match.index).split("\n").length;
        violations.push(`${name}:${line}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
