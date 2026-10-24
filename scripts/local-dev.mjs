#!/usr/bin/env node
/**
 * `pnpm dev` — dashboard (Vite :5173), Worker (wrangler :8788), OAuth loopback.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const children = [];

function run(cmd, args, label) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code !== 0 && code !== null) {
      console.error(`[local-dev] ${label} exited ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("node", ["scripts/oauth-loopback.mjs"], "oauth-loopback");
run("pnpm", ["exec", "turbo", "run", "dev", "--filter=@shiba/backend", "--filter=@shiba/frontend"], "turbo-dev");
