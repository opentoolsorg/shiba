#!/usr/bin/env node
/**
 * Shiba operator CLI — thin wrapper around local checks + live /api/setup/status.
 * Usage: pnpm shiba doctor [--host URL] [--strict] [--json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BACKEND = `${ROOT}/apps/backend`;

function fail(message, code = 1) {
  console.error(`shiba: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] !== "doctor") {
    console.log("Usage: pnpm shiba doctor [--host URL] [--strict] [--json]");
    process.exit(argv.length === 0 ? 0 : 1);
  }
  const opts = parseArgs(argv);
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

main();
