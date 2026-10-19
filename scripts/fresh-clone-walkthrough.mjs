#!/usr/bin/env node
/**
 * Scripted fresh-clone walkthrough. Prints a log and exits 1 on a dead end.
 * No network, no secrets, no Docker.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { walkthroughFreshClone } from "./shiba-setup-lib.mjs";

const out = process.argv.find((arg) => arg.startsWith("--out="));
try {
  const result = walkthroughFreshClone();
  process.stdout.write(`${result.log}\n`);
  if (out) {
    const path = out.slice("--out=".length);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${result.log}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
