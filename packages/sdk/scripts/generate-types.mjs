#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(root, "..");
const spec = path.join(pkgRoot, "../../apps/backend/src/v1/openapi.json");
const out = path.join(pkgRoot, "src/generated/openapi.ts");
const require = createRequire(path.join(pkgRoot, "package.json"));
const cli = path.join(path.dirname(require.resolve("openapi-typescript/package.json")), "bin/cli.js");

execFileSync(process.execPath, [cli, spec, "-o", out, "--export-type"], { stdio: "inherit", cwd: pkgRoot });
