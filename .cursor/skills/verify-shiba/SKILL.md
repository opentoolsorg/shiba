---
name: verify-shiba
description: Drive and prove the shiba dashboard locally (task composer, approvals, sandbox runs, PR publish, review findings, run registry) with Playwright evidence. Use when verifying Phase 1 review-loop behaviour or any dashboard journey against wrangler dev.
---

# verify-shiba

Prove dashboard behaviour from the real UI path. Never claim live GitHub success from mock boundary mode.

## Launch

Run `scripts/launch.sh`. It installs, builds, copies `.dev.vars` from the example when missing (never prints values), applies local D1 migrations, starts `wrangler dev`, and writes PID/port under `.verify/`.

Ready means `/api/setup/status` returns JSON (not SPA HTML) **and** `/app/` returns HTML.

`--persist-to` is passed to both `d1 migrations apply` and `wrangler dev`. If the pinned wrangler 4.118.0 rejects it, the script falls back to `.wrangler/state` and records that in `.verify/persist-mode`.

Use `--local-upstream localhost` so loopback auth works.

## Doctor

Run `scripts/doctor.sh` (read-only). Checks: recorded PID is alive and owns the port, `docker info`, wrangler version matches `package.json`, `/api/setup/status` is JSON, and `GITHUB_TOKEN` is present in `.dev.vars` (boolean only).

## Drive

`node scripts/drive.mjs --feature <name>` opens `http://localhost:$PORT/app/` in Playwright Chromium.

Handles: Task composer, Task description, Project, Search repositories, Create pull request, Send task, Approve/Reject, pr-card, review-findings, browser E2E manifest links on published PRs (see `browser-e2e-evidence`).

Features live in `features/`.

## Evidence

`scripts/evidence.sh` writes `.verify/evidence/<ISO-ts>/`: step + final screenshots, Playwright trace, HAR, wrangler log tail, `docker ps -a`, and JSON read-backs. Label mock journeys mock GitHub.

## Cleanup

`scripts/cleanup.sh` kills only the recorded PID, stops only recorded container IDs, deletes `.verify/state`, and keeps `.verify/evidence`.

## Helpers

- Mock boundary mode (default when SHIBA_TEST_REPO is unset): start a local GitHub stub and point the Worker at it. Evidence is not live proof.
- Playwright is installed on demand via `npx playwright` under `.cursor/skills/verify-shiba/`.
- **CI:** `scripts/run-ci.sh` with `VERIFY_GITHUB=mock`, `VERIFY_SKIP_INSTALL=1`, and `VERIFY_SKIP_BUILD=1` after `pnpm build`. Wrangler runs with `--local --enable-containers=false` (no Cloudflare token). Playwright fills the composer, then queues through `POST /api/runs` (`VERIFY_USE_RUNS_API=1`) because the chat orchestrator needs the remote AI binding. Ports default to `8788` (wrangler) and `8799` (GitHub stub). Set `PLAYWRIGHT_BROWSERS_PATH` to cache browsers. GitHub Actions job `verify-shiba` in `.github/workflows/ci.yml` uploads `.verify/evidence/` and `.verify/drive/` artifacts.

## Features

See `features/README.md`.
