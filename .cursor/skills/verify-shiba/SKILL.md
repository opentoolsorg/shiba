---
name: verify-shiba
description: Drive and prove the shiba dashboard locally (task composer, approvals, sandbox runs, PR publish, review findings, run registry) with Playwright evidence. Use when verifying Phase 1 review-loop behaviour or any dashboard journey against wrangler dev.
---

# verify-shiba

Prove dashboard behaviour from the real UI path. The local CI workaround submits and approves via API; evidence labels approval as `approve (API)`, not a dashboard click. Findings are still required to render in the run-specific Diff view. Never claim live GitHub success from mock boundary mode.

## Launch

Run `scripts/launch.sh`. It installs, builds, writes an invocation-scoped `.verify/run.env` (derived from `.dev.vars`, or the example when missing; never prints values; `.dev.vars` is never modified) passed to `wrangler dev --env-file`, applies local D1 migrations, starts `wrangler dev`, and writes PID/port under `.verify/`.

Ready means `/api/setup/status` returns JSON (not SPA HTML) **and** `/app/` returns HTML.

`--persist-to` is passed to both `d1 migrations apply` and `wrangler dev`. If the pinned wrangler (see root `package.json`, currently 4.140.0) rejects it, the script falls back to `.wrangler/state` and records that in `.verify/persist-mode`.

When a compatible Chromium is already installed, set `VERIFY_BROWSER_EXECUTABLE_PATH` to its executable path. The launcher validates that path and skips the browser download; the driver uses the same executable. Omit it to use Playwright's downloaded Chromium.

Use `--local-upstream localhost` so loopback auth works.

## Doctor

Run `scripts/doctor.sh` (read-only). Checks: recorded PID is alive and owns the port, `docker info`, wrangler version matches `package.json`, `/api/setup/status` is JSON, and `GITHUB_TOKEN` is present in `.dev.vars` (boolean only).

## Drive

`node scripts/drive.mjs --feature <name>` opens `http://localhost:$PORT/app/` in Playwright Chromium.

Handles: Task composer, Task description, Project, Search repositories, Create pull request, Send task, Approve/Reject, pr-card, review-findings, browser E2E manifest links on published PRs (see `browser-e2e-evidence`).

Features live in `features/`.

## Assert

`node scripts/assert-journey.mjs` after `drive.mjs`. Polls `/api/runs`, `/api/v1/threads/:id/pr/review`, and, in recorded mock mode only, the GitHub stub `GET /__shiba/state`. Live mode uses authenticated, read-only `gh api --hostname github.com --method GET` pull/review/comment read-backs (requires an existing gh login); missing or mismatched proof fails explicitly, without consulting any stub. **Fails the process** on missing evidence. Container-only checks are marked `skipped` when `containers-mode` is disabled (CI path).

## Journeys

For custom bots and named threads, start `pnpm dev` and run `node .cursor/skills/verify-shiba/scripts/drive-agent-threads.mjs` (optionally set `VERIFY_APP_URL` to another loopback origin). This creates local fixture records through the UI, starts a profile-associated thread, checks rename failure and retry, refresh persistence, default-session isolation, and mobile overflow. It writes `.verify/agent-threads/result.json`, screenshots, and a trace. This journey makes no model, GitHub, or container calls and does not prove message streaming or model execution.

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

For the configured Bot lifecycle, set `VERIFY_AGENT_LIFECYCLE=1` with the mock CI runner. `drive-agent-lifecycle.mjs` requires declared mock GitHub, disabled containers, enabled stand-in, `VERIFY_AGENT_LIFECYCLE_MOCK=1`, and an HTTP loopback origin matching the recorded Worker port. Its 11 checks use visible navigation, Create bot, Launch bot, composer Send task and human Approve clicks. They prove failed-submit draft recovery, the same command ID on retry, exact session/configuration and approval ownership, frozen version/instructions/model on the synthetic completed run, visible provenance, and archive/restore preserving history. Successful Bot queueing uses the actual product UI, without an API submission seam. Read-only API assertions and negative authorization probes remain explicit. It writes `.verify/agent-lifecycle/` evidence and cleans only IDs it created. This is not live model or container execution proof.

## Gates

Repo gate (required before merge): `pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built` and `pnpm check:ci`.

Stop development services started by the task before the full unit gate: the desktop callback suite needs OAuth loopback port 51121. On small hosts, `pnpm test --concurrency=1 -- --maxWorkers=2` runs the same suites with bounded parallelism; avoid concurrent builds/typechecks during this test run. Restart development services afterwards.

verify-shiba gate: `bash .cursor/skills/verify-shiba/scripts/run-ci.sh` after `pnpm build` (CI sets `VERIFY_SKIP_BUILD=1`).

CI also sets `VERIFY_AGENT_THREADS=1` to run the bot/thread journey against the same local Worker before cleanup and upload `.verify/agent-threads/` evidence. This is real local UI/API/storage coverage, separate from the mock execution boundary.

CI sets `VERIFY_AGENT_LIFECYCLE=1` for the configured-profile lifecycle and uploads `.verify/agent-lifecycle/`. To run both journeys locally after a build:

```bash
VERIFY_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
VERIFY_GITHUB=mock VERIFY_PORT=8790 VERIFY_SKIP_INSTALL=1 VERIFY_SKIP_BUILD=1 \
VERIFY_AGENT_THREADS=1 VERIFY_AGENT_LIFECYCLE=1 \
bash .cursor/skills/verify-shiba/scripts/run-ci.sh
```

Omit `VERIFY_BROWSER_EXECUTABLE_PATH` when using the Playwright-managed Chromium installation.

Set `VERIFY_DESKTOP=1` on the lifecycle driver to run the same actual dashboard journey inside the built Electron application. The desktop adapter uses a fresh local profile/run directory, enables Chromium sandboxing, and verifies the desktop bridge, renderer Node isolation, and sandbox preferences. Desktop artifacts go to `.verify/desktop-agent-lifecycle/`. Build with `pnpm -C apps/desktop build` first. Linux needs a display and a working Chromium sandbox; this cloud host uses the tested activation in `docs/audits/desktop-web-e2e.md`. Native macOS CI uses its own display and must be reported separately from Linux results.

For actual local-daemon execution, `drive-local-runtime.mjs` uses an isolated local Worker with `SHIBA_LOCAL_RUNTIME=1`, local pairing/auth keys and separate D1 state. It creates a disposable authenticated dashboard account, pairs the real daemon, then uses the Bots/composer/approval/tool-permission UI to execute a native Git fixture and inspect its persisted diff. `VERIFY_DESKTOP=1` runs this same dashboard inside Electron. Only the model CLI is a deterministic Claude-protocol fixture; native Git, permission gating, file edits, diff collection, cancellation and run-owned subprocess cleanup are real. Evidence is separate under `.verify/local-daemon-e2e/ui-web/` and `ui-desktop/`. Never point this disposable-account harness at a production origin or use an operator's real Git/auth configuration. See `docs/audits/local-runtime.md` and `docs/audits/bots-e2e.md` for setup and limits.

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
