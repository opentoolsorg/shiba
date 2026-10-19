#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(root, "..");
const generated = path.join(pkgRoot, "src/generated/openapi.ts");
const before = readFileSync(generated, "utf8");

execFileSync(process.execPath, [path.join(root, "generate-types.mjs")], { stdio: "inherit" });

const after = readFileSync(generated, "utf8");
if (before !== after) {
  console.error("@shiba/sdk: generated OpenAPI types are out of sync. Run pnpm -C packages/sdk generate:types");
  process.exit(1);
}
console.log("@shiba/sdk: OpenAPI types are in sync.");
