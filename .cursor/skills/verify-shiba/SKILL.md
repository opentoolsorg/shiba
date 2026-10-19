---
name: verify-shiba
description: Drive and prove the shiba dashboard locally (task composer, approvals, sandbox runs, PR publish, review findings, run registry) with Playwright evidence. Use when verifying Phase 1 review-loop behaviour or any dashboard journey against wrangler dev.
---

# verify-shiba

Prove dashboard behaviour from the real UI path. Never claim live GitHub success from mock boundary mode.

## Launch

Run `scripts/launch.sh`. It installs, builds, writes an invocation-scoped `.verify/run.env` (derived from `.dev.vars`, or the example when missing; never prints values; `.dev.vars` is never modified) passed to `wrangler dev --env-file`, applies local D1 migrations, starts `wrangler dev`, and writes PID/port under `.verify/`.

Ready means `/api/setup/status` returns JSON (not SPA HTML) **and** `/app/` returns HTML.

`--persist-to` is passed to both `d1 migrations apply` and `wrangler dev`. If the pinned wrangler 4.118.0 rejects it, the script falls back to `.wrangler/state` and records that in `.verify/persist-mode`.

Use `--local-upstream localhost` so loopback auth works.

## Doctor

Run `scripts/doctor.sh` (read-only). Checks: recorded PID is alive and owns the port, `docker info`, wrangler version matches `package.json`, `/api/setup/status` is JSON, and `GITHUB_TOKEN` is present in `.dev.vars` (boolean only).

## Drive

`node scripts/drive.mjs --feature <name>` opens `http://localhost:$PORT/app/` in Playwright Chromium.

Handles: Task composer, Task description, Project, Search repositories, Create pull request, Send task, Approve/Reject, pr-card, review-findings, browser E2E manifest links on published PRs (see `browser-e2e-evidence`).

Features live in `features/`.

## Assert

`node scripts/assert-journey.mjs` after `drive.mjs`. Polls `/api/runs`, `/api/v1/threads/:id/pr/review`, and the GitHub stub `GET /__shiba/state`. **Fails the process** on missing evidence. Container-only checks are marked `skipped` when `containers-mode` is disabled (CI path).

## Journeys

| Feature | Mode | Proves |
| --- | --- | --- |
| `core-loop-mock` | mock GitHub + stand-in when containers off | submit → approve → run completes → stub PR → review posted → round `posted` (**CI default**) |
| `task-submit-and-approval` | UI only | approval card + reject does not start a container |
| `sandbox-run-and-diff` | needs `VERIFY_ENABLE_CONTAINERS=1` + Docker | real container + diff (skipped honestly in CI) |
| `review-findings` | same loop as `core-loop-mock` | findings UI + API/stub read-backs |

The stand-in (`SHIBA_VERIFY_STANDIN=1` in `run.env`) is on only when containers are disabled **and** GitHub is the loopback mock; every other launch forces it to `0`, overriding stale values. The Worker guard (`verifyStandinEnabled`) also requires `GITHUB_API_BASE` to be an explicit `http://127.0.0.1|localhost|[::1]` origin, so live or non-loopback GitHub never gets synthetic runs. `VERIFY_ENABLE_CONTAINERS=1` with Docker unavailable exits 1 (no silent stand-in), and `VERIFY_GITHUB=live` drops any stale mock base. `VERIFY_PLAN_ONLY=1` writes the mode files and `run.env` then exits (used by `apps/backend/test/verify-standin-guard.test.ts`). The stand-in is **not** live model or live GitHub proof.

## Run locally

```bash
pnpm build
VERIFY_GITHUB=mock VERIFY_FEATURE=core-loop-mock bash .cursor/skills/verify-shiba/scripts/run-ci.sh
```

Containers on (real sandbox — needs Docker + model credentials):

```bash
VERIFY_ENABLE_CONTAINERS=1 VERIFY_FEATURE=sandbox-run-and-diff bash .cursor/skills/verify-shiba/scripts/launch.sh
node .cursor/skills/verify-shiba/scripts/drive.mjs --feature sandbox-run-and-diff
node .cursor/skills/verify-shiba/scripts/assert-journey.mjs
```

## Gates

Repo gate (required before merge): `pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built` and `pnpm check:ci`.

verify-shiba gate: `bash .cursor/skills/verify-shiba/scripts/run-ci.sh` after `pnpm build` (CI sets `VERIFY_SKIP_BUILD=1`).

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
