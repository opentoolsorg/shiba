import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const targets = [];
for (const entry of readdirSync("apps", { withFileTypes: true })) {
  if (entry.isDirectory()) targets.push(`apps/${entry.name}/src`);
}
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  targets.push(`packages/${entry.name}/src`, `packages/${entry.name}/test`);
}
const existing = targets.filter((target) => existsSync(target));
const eslint = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));
const result = spawnSync(process.execPath, [eslint, ...existing], { stdio: "inherit" });
process.exit(result.status ?? 1);
