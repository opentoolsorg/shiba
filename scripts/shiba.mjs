#!/usr/bin/env node
/**
 * Shiba operator CLI — `pnpm shiba dev` starts local Worker + Sandbox.
 * Node stdlib only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPO_ROOT,
  checkNodeVersion,
  checkPnpmVersion,
  ensureDevVars,
  formatDryRun,
  nextStepsBanner,
  planDevSteps,
} from "./shiba-dev-lib.mjs";

const args = process.argv.slice(2);

function fail(message, code = 1) {
  console.error(`shiba: ${message}`);
  process.exit(code);
}

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function capture(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
}

function runStep(step) {
  const env = { ...process.env, ...step.env };
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`step ${step.id} failed (${step.cmd} ${step.args.join(" ")})`, result.status ?? 1);
  }
}

function checkPrerequisites() {
  const node = checkNodeVersion();
  if (!node.ok) {
    fail(`Node.js ${node.min}+ required (found ${node.version})`);
  }

  const pnpm = capture("pnpm", ["--version"], { cwd: REPO_ROOT });
  if (pnpm.status !== 0) {
    fail("pnpm is required — install pnpm 10+ and re-run");
  }
  const pnpmCheck = checkPnpmVersion(pnpm.stdout);
  if (!pnpmCheck.ok) {
    fail(`pnpm ${pnpmCheck.min}+ required (found ${pnpmCheck.version})`);
  }

  const wrangler = capture("npx", ["wrangler", "--version"], { cwd: REPO_ROOT });
  if (wrangler.status !== 0) {
    fail("wrangler not available — run pnpm install from the repo root");
  }

  const docker = capture("docker", ["info"], { stdio: "pipe" });
  if (docker.status !== 0) {
    fail(
      "Docker is not running — start Docker Desktop/OrbStack, then re-run. Sandbox containers need a local engine.",
    );
  }

  console.log("  ✓ Node.js", node.version);
  console.log("  ✓ pnpm", pnpmCheck.version.trim());
  console.log("  ✓ wrangler", (wrangler.stdout || wrangler.stderr).trim().split("\n")[0]);
  console.log("  ✓ docker");
}

function cmdDev() {
  const dryRun = flag("dry-run");
  const onlyDevVars = flag("only-dev-vars");
  const skipInstall = flag("skip-install") || existsSync(resolve(REPO_ROOT, "node_modules/.pnpm"));
  const skipBuild = flag("skip-build");
  const skipImage = flag("skip-image");
  const port = Number(opt("port", "8788"));
  const persistTo = opt("persist-to", ".shiba/local-state");

  if (onlyDevVars) {
    const { appended } = ensureDevVars();
    if (appended.length) {
      console.log(`  ✓ apps/backend/.dev.vars updated (${appended.length} local secret(s) minted)`);
    } else {
      console.log("  ✓ apps/backend/.dev.vars ready");
    }
    return;
  }

  if (dryRun) {
    const plan = planDevSteps({
      skipInstall,
      skipBuild,
      skipImage,
      port,
      persistTo,
    });
    console.log(formatDryRun(plan));
    console.log(nextStepsBanner({ port }));
    return;
  }

  console.log("\n== shiba dev (local Worker + Sandbox) ==\n");
  checkPrerequisites();

  const plan = planDevSteps({
    skipInstall,
    skipBuild,
    skipImage,
    port,
    persistTo,
  });

  let generatedKeys = [];
  for (const step of plan.steps) {
    if (step.id === "dev-vars") {
      const { appended } = ensureDevVars();
      generatedKeys = appended;
      if (appended.length) {
        console.log(`  ✓ .dev.vars (${appended.length} local secret(s) minted, existing values kept)`);
      } else {
        console.log("  ✓ .dev.vars");
      }
      continue;
    }
    console.log(`\n→ ${step.id}`);
    runStep(step);
  }

  console.log(nextStepsBanner({ port, generatedKeys }));
}

function printHelp() {
  console.log(`Usage: pnpm shiba <command> [options]

Commands:
  dev    Local Worker + Sandbox (prereqs, .dev.vars, D1 migrate, image build, wrangler dev)

Dev options:
  --dry-run           Print the planned commands without running them
  --skip-install      Skip pnpm install (default when node_modules exists)
  --skip-build        Skip pnpm build
  --skip-image        Skip wrangler containers build
  --port=<n>          Wrangler port (default: 8788)
  --persist-to=<dir>  Local persistence directory (default: .shiba/local-state)
  --only-dev-vars     Internal: merge .dev.vars only

Examples:
  pnpm shiba dev
  pnpm shiba dev --dry-run
  bash scripts/dev.sh
`);
}

const sub = args[0];
if (!sub || sub === "--help" || sub === "-h") {
  printHelp();
  process.exit(sub ? 0 : 1);
}

if (sub === "dev") {
  cmdDev();
} else {
  fail(`unknown command "${sub}" — run pnpm shiba --help`);
}
