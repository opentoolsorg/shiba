#!/usr/bin/env node
/** Restore the requested upstream skills without changing agent accounts or app dependencies. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE = "@morphllm/morph-setup";
const VERSION = "1.0.72";
const INTEGRITY = "sha512-M1MgjOoGgQ3BbVnQlKrkAuqfzfaWkVGmgvqUsu2gNqzkS2PzBcHq73Pd7VKFuJnCPRtQ+W4Rv/fYwPDIPdnBeQ==";
const SKILLS = ["morph-cli", "explore", "fast-apply", "code-research", "feature-research"];
const { values } = parseArgs({ options: { root: { type: "string" }, "cache-dir": { type: "string" } } });
const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const cache = resolve(values["cache-dir"] ?? join(root, ".shiba", "tools", "morph-skills"));
mkdirSync(cache, { recursive: true });
const archive = join(cache, "morphllm-morph-setup-1.0.72.tgz");

if (!existsSync(archive)) {
  execFileSync("npm", ["pack", `${PACKAGE}@${VERSION}`, "--ignore-scripts", "--pack-destination", cache, "--json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
}
const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
if (integrity !== INTEGRITY) throw new Error("Morph skill archive integrity mismatch; refusing installation.");

const planned = SKILLS.map((name) => {
  const relative = `.agents/skills/${name}/SKILL.md`;
  const content = execFileSync("tar", ["-xOf", archive, `package/${relative}`], { maxBuffer: 1024 * 1024 });
  const path = join(root, relative);
  for (const ancestor of [join(root, ".agents"), join(root, ".agents", "skills"), dirname(path), path]) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing a symlink in Morph skill destination: ${ancestor}`);
    }
  }
  if (existsSync(path) && !readFileSync(path).equals(content)) {
    throw new Error(`Existing Morph skill differs; preserving local edits: ${relative}`);
  }
  return { path, relative, content, sha256: createHash("sha256").update(content).digest("hex") };
});

const manifestPath = join(root, ".agents", "skills", "morph-skills-source.json");
if (lstatSync(manifestPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw new Error("Refusing a symlink for the Morph skill provenance manifest.");
}
for (const skill of planned) {
  mkdirSync(dirname(skill.path), { recursive: true });
  if (!existsSync(skill.path)) writeFileSync(skill.path, skill.content);
}
const manifest = {
  source: PACKAGE,
  version: VERSION,
  registry: "https://registry.npmjs.org/@morphllm/morph-setup",
  integrity,
  upstreamLicense: "MIT",
  skills: planned.map(({ relative, sha256 }) => ({ path: relative, sha256 })),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Verified and restored ${planned.length} Morph skills from ${PACKAGE}@${VERSION}.`);
