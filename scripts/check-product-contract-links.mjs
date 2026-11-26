import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const repo = new URL("../", import.meta.url);
const contract = "docs/product/ai-employees.md";
assert((await stat(new URL(contract, repo))).isFile(), `Missing product contract: ${contract}`);

const entryPoints = [
  ["CLAUDE.md"],
  ["apps/web/docs/agents/domain.md"],
  ["CONTRIBUTING.md"],
  ["apps/web/src/content/docs/docs/contributing.md", "https://github.com/opentoolsorg/shiba/blob/main/"],
];

for (const [path, linkBase = repo] of entryPoints) {
  const source = new URL(path, repo);
  const text = await readFile(source, "utf8");
  const links = [...text.matchAll(/\[product contract\]\(([^)\s]+)\)/gi)]
    .map(([, href]) => new URL(href, source).href);
  assert.deepEqual(links, [new URL(contract, linkBase).href], `${path} must link to the current product contract`);
}
console.log(`Verified product contract links in ${entryPoints.length} entrypoints.`);
