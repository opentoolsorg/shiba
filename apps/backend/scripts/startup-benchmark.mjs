#!/usr/bin/env node
/** Run wrangler check startup N times; print each Active ms and summary stats. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = process.argv[4]
  ? resolve(process.argv[4])
  : process.env.BACKEND_ROOT
    ? resolve(process.env.BACKEND_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(backendRoot, ".wrangler/startup-report");
const runs = Number(process.argv[2] ?? 5);
const bundle = join(outRoot, "worker.bundle");

mkdirSync(outRoot, { recursive: true });

const wrangler = (args) => {
  const r = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: backendRoot,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "wrangler failed").trim().slice(-1200));
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
};

wrangler([
  "deploy",
  "--dry-run",
  `--config=${join(backendRoot, "wrangler.jsonc")}`,
  "--containers-rollout",
  "none",
  `--outfile=${bundle}`,
  `--outdir=${outRoot}`,
]);

const bundleKiB = (statSync(bundle).size / 1024).toFixed(1);
const activeMs = [];

for (let i = 0; i < runs; i++) {
  const log = wrangler([
    "check",
    "startup",
    `--workerBundle=${bundle}`,
    `--config=${join(backendRoot, "wrangler.jsonc")}`,
  ]);
  const match = log.match(/Active:\s+([\d.]+)\s+ms/);
  if (!match) throw new Error(`Run ${i + 1}: could not parse Active ms\n${log.slice(-400)}`);
  const ms = Number(match[1]);
  activeMs.push(ms);
  console.log(`run ${i + 1}/${runs}: Active ${ms} ms`);
}

const sorted = [...activeMs].sort((a, b) => a - b);
const median = sorted.length % 2 === 1
  ? sorted[(sorted.length - 1) / 2]
  : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
const min = sorted[0];
const max = sorted[sorted.length - 1];

const summary = { bundleKiB: Number(bundleKiB), runs: activeMs, min, median, max };
const outFile = process.argv[3];
if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");

console.log(JSON.stringify({ bundleKiB, activeMs, min, median, max }));