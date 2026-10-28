# Local runtime and browser evidence

Validated on 2026-10-28 on branch `codex/overlay-parity-audit`, using Node 24.19.0, repository-pinned pnpm 10.34.4, Wrangler 4.140.0, Playwright 1.55.1, and system Chromium 154.0.8037.57.

## Reproducible fixes

1. `scripts/local-dev.mjs` spread `opts` after its merged environment. For OAuth subprocesses, `opts.env` replaced the whole inherited environment, losing `PATH`; startup failed with `spawn node ENOENT`. The launcher now uses `localDevProcessOptions`, which merges individual overrides after other process options. Spawn failures shut down the launcher with an error.
2. The same launcher ignored local D1 migration failures and continued launching services against unprepared storage. It now preserves the migration's exit status and starts no services on failure.
3. The container-disabled plan lacked Wrangler's explicit `--local` switch. With the production binding configuration it attempted a remote proxy session and demanded a Cloudflare token. The container-disabled plan now uses `--local --enable-containers=false`. This prepares the documented API/UI smoke workflow; it does not configure remote Workers AI or Vectorize.
4. The browser harness assumed it could download Chromium. The environment's network policy rejected the Playwright CDNs with HTTP 403. `VERIFY_BROWSER_EXECUTABLE_PATH` now lets both launcher and driver use an existing compatible browser without downloading one or disabling verification.

## Commands and outcomes

Initialize the installed tools with `source /workspace/.tools/shiba-env.sh` and run commands from `/workspace/shiba` in this onboarding environment. The environment settings contain reusable initialization for future tasks.

| Check | Result | Evidence and limit |
| --- | --- | --- |
| `pnpm -C apps/backend test test/deploy-scripts.test.ts` | PASS: 39 tests | Includes inherited-environment executable lookup, container-disabled local flags, and migration failure stopping all startup. |
| `pnpm dev` | PASS for local services | OAuth listeners on 51121/56121, Vite on `localhost:5173`, Worker on 8788. Vite proxies `/api/setup/status` to JSON from the Worker. Vite's default localhost binding resolves to IPv6 on this machine; use `localhost`, not an assumed IPv4 binding. |
| Local D1 migrations repeated | PASS | First application succeeded; repeat reported no migrations to apply. |
| Worker `/api/setup/status`, `/app/` | PASS | JSON setup response and HTML dashboard returned HTTP 200. |
| Normal task queue without provider configuration | Expected configuration failure | HTTP 400 explains missing model connection/gateway. This is not a successful coding run. |
| Existing `core-loop-mock` browser journey | PASS: 11 assertions | Approval visible, API approval accepted, synthetic coding run completes, mock PR created, review persisted, review findings rendered, mock reviewer comment posted. Approval is via API, not an Approve-button click. |
| Bot/thread browser journey | PASS: 9 assertions in the combined gate | Real local UI/API/D1: profile creation, fresh associated thread, failed rename leaves persisted state unchanged, retry succeeds, refresh retains metadata/name, default-session switching clears/restores profile, per-bot list reopens the thread, rename supports focus/Escape, and 390px layout avoids horizontal overflow. |
| Configured Bot lifecycle in browser and Electron | PASS: 11 checks each against the built Worker dashboard | Create/edit/reload Bot, launch/reopen thread, actual composer submission with 503 recovery and same-command-ID retry, scoped frozen v2 approval, edit to v3, human Approve click, synthetic v2 completion, scoped review/PR panels, archive/restore/history. No live credential connection is claimed. |
| Real local-daemon execution in browser and Electron | PASS: 9 UI steps + 12 protocol checks each | Actual UI Bot launch/task/tool approval, native Git edit/diff persistence, scoped review display, and API cancellation stopping CLI descendants. Only model CLI is a fixture. See [local runtime](local-runtime.md). |
| Shell syntax / focused lint | PASS, warnings remain | `bash -n` launcher; Biome focused check exits zero with existing warning diagnostics. No auto-fixes applied. |

Reproduce the mock execution journey after a build:

```bash
VERIFY_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
VERIFY_PORT=8790 VERIFY_GITHUB=mock VERIFY_FEATURE=core-loop-mock \
VERIFY_AGENT_THREADS=1 VERIFY_AGENT_LIFECYCLE=1 \
VERIFY_SKIP_INSTALL=1 VERIFY_SKIP_BUILD=1 \
bash .cursor/skills/verify-shiba/scripts/run-ci.sh
```

Reproduce the real local bot/thread journey with `pnpm dev` running:

```bash
VERIFY_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
node .cursor/skills/verify-shiba/scripts/drive-agent-threads.mjs
```

The latter only permits loopback targets, creates its own local fixture records, and deletes only the IDs returned by that invocation after screenshots and refresh checks. Optional `VERIFY_APP_URL` selects another loopback server, including the built Worker on port 8788.

The lifecycle driver is also integrated into the mock CI runner through `VERIFY_AGENT_LIFECYCLE=1` and has evidence-preservation coverage (4 tests passed in `test/verify-ci-evidence.test.ts`). To run it against a launched mock Worker directly, use the same `VERIFY_DIR` as its launcher, set `VERIFY_AGENT_LIFECYCLE_MOCK=1`, and run `node .cursor/skills/verify-shiba/scripts/drive-agent-lifecycle.mjs`. Bot queueing and human approval now use actual product buttons. The direct configured-Bot intake does not need remote chat planning, and no chat response is fabricated.

The combined command exited **0**, with **31 assertions passed** (11 mock core-loop, 9 bot/thread, 11 Bot lifecycle). The affected 11 were refreshed again in browser and Electron after the final session-routing fix. Journeys ran against packaged `app-public/` on isolated local Workers. Exact-ID fixture cleanup returned HTTP 200; owned processes were stopped. The lifecycle driver also rejects a target whose port differs from the recorded mock Worker before any fixture writes; the mismatched-port check failed as expected.

## Evidence files and proof boundaries

The current machine retains ignored artifacts:

- `.verify/evidence/ci-local-20261028T044738Z/`: existing mock core-loop screenshots, trace/HAR, log tail, and API read-backs.
- `.verify/evidence/ci-local-20261028T050306Z/`: combined mock core-loop and real local bot/thread CI-driver run; both journeys passed and exact-ID fixture cleanup returned HTTP 200.
- `.verify/evidence/ci-local-20261028T052829Z/`: final combined gate against built dashboard assets; all 31 checks passed. The lifecycle artifacts remain in the dedicated directory below.
- `.verify/drive/assertions.json`: all 11 mock assertions with `githubMode=mock`, `containersMode=disabled`, and `standinMode=enabled`.
- `.verify/agent-threads/result.json`, `trace.zip`, `renamed-thread.png`, `mobile-thread.png`: local bot/thread assertions and browser artifacts.
- `.verify/agent-lifecycle/result.json`, `trace.zip`, `pending-approval.png`, `completed-profile-run.png`, `restored-agent-history.png`: configured profile lifecycle, frozen approval/run read-backs, and browser artifacts.
- `/tmp/shiba-runtime-tests.log`, `/tmp/shiba-dev-fixed.log`, `/tmp/shiba-core-loop-browser.log`: command output for this session.
- `/tmp/shiba-combined-agent-built.log`: final combined gate output, successful evidence collection, and cleanup.

These checks establish local development capability and the named UI/storage behavior. They do **not** establish live model inference, live GitHub clone/PR permissions, real sandbox container execution, remote browser rendering, production OAuth callbacks, Vectorize retrieval, scheduled cloud execution, or production deployment. No live provider requests, external messages, deployments, merges, or production publication were performed by these browser journeys.
