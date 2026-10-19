#!/usr/bin/env node
/**
 * Shiba operator CLI — `pnpm shiba dev` / `pnpm shiba doctor`.
 * Node stdlib only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const BACKEND = `${REPO_ROOT}/apps/backend`;
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

function parseDoctorArgs(argv) {
  const opts = { strict: false, json: false, host: process.env.SHIBA_HOST ?? "http://127.0.0.1:8788" };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "doctor") continue;
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--host") {
      const value = rest.shift();
      if (!value) fail("--host requires a URL.");
      opts.host = value.replace(/\/$/, "");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm shiba doctor [--host URL] [--strict] [--json]");
      process.exit(0);
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

function localChecks() {
  const lines = [];
  const devVars = `${BACKEND}/.dev.vars`;
  if (existsSync(devVars)) {
    const body = readFileSync(devVars, "utf8");
    lines.push(/^GITHUB_TOKEN=.+$/m.test(body) ? "local GITHUB_TOKEN=present" : "local GITHUB_TOKEN=absent");
  } else {
    lines.push("local .dev.vars=missing");
  }
  const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
  lines.push(docker.status === 0 ? "docker=ok" : "docker=unavailable (sandbox runs need a local engine)");
  return lines;
}

async function fetchDoctor(host) {
  const response = await fetch(`${host}/api/setup/status`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET /api/setup/status → ${response.status}`);
  }
  const body = await response.json();
  if (!body?.doctor) {
    throw new Error("Response missing doctor field — is the Worker on this branch?");
  }
  return body.doctor;
}

function printDoctor(doctor) {
  const lines = [];
  lines.push(doctor.ok ? "setup doctor: ok" : "setup doctor: problems found");
  for (const finding of doctor.findings ?? []) {
    const tag = finding.severity === "ok" ? "✓" : finding.severity === "warn" ? "!" : "✗";
    lines.push(`${tag} ${finding.id}: ${finding.message}`);
    if (finding.fix) lines.push(`    fix: ${finding.fix}`);
  }
  for (const row of doctor.roles ?? []) {
    const route =
      `${row.role} → ${row.harness} / ${row.model}` + (row.connectionId ? ` (${row.connectionId})` : "");
    lines.push(row.ok ? `✓ ${route}` : `✗ ${route}: ${row.message ?? "blocked"}`);
    if (!row.ok && row.fix) lines.push(`    fix: ${row.fix}`);
  }
  return lines.join("\n");
}

async function cmdDoctor() {
  const opts = parseDoctorArgs(args);
  for (const line of localChecks()) {
    console.log(line);
  }
  try {
    const doctor = await fetchDoctor(opts.host);
    if (opts.json) {
      console.log(JSON.stringify(doctor, null, 2));
    } else {
      console.log(printDoctor(doctor));
    }
    if (opts.strict && !doctor.ok) process.exit(1);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)} — start the Worker (pnpm dev:backend) or pass --host.`,
    );
  }
}

function printHelp() {
  console.log(`Usage: pnpm shiba <command> [options]

Commands:
  dev      Local Worker + Sandbox (prereqs, .dev.vars, D1 migrate, image build, wrangler dev)
  doctor   Local checks + live /api/setup/status from a running Worker

Dev options:
  --dry-run           Print the planned commands without running them
  --skip-install      Skip pnpm install (default when node_modules exists)
  --skip-build        Skip pnpm build
  --skip-image        Skip wrangler containers build
  --port=<n>          Wrangler port (default: 8788)
  --persist-to=<dir>  Local persistence directory (default: .shiba/local-state)
  --only-dev-vars     Internal: merge .dev.vars only

Doctor options:
  --host URL          Worker base URL (default: http://127.0.0.1:8788 or SHIBA_HOST)
  --strict            Exit 1 when doctor reports problems
  --json              Print doctor JSON

Examples:
  pnpm shiba dev
  pnpm shiba dev --dry-run
  pnpm shiba doctor --strict
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
} else if (sub === "doctor") {
  cmdDoctor();
} else {
  fail(`unknown command "${sub}" — run pnpm shiba --help`);
}
