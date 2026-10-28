# Desktop and web verification

See the [final recheck](final-recheck.md) for the latest **3,166 passed,
3 skipped** repository suite and refreshed browser/Electron evidence.
Earlier counts and run IDs below are historical.

On 2026-10-28, the built Electron application ran on Linux under an authenticated Xvfb display. The actual desktop window loaded Shiba's built dashboard from a real local Cloudflare Worker. This is executable desktop/web integration evidence; it is not native macOS execution evidence.

## Results

| Check | Outcome | What executed |
| --- | --- | --- |
| Desktop source and test typecheck | PASS | `pnpm -C apps/desktop typecheck`. |
| Desktop shell/harness E2E suite | PASS: 5 tests across 3 files | Real Electron windows, local HTML/API stubs, real daemon protocol with a fake Claude process, native diff window, mocked OS external-link handoff, setup page, and setup submission selecting a deployment. These fixtures do not prove production login or live model execution. |
| Desktop real-dashboard Bot lifecycle | PASS: 11 checks | Real Electron window/preload, built React dashboard, local Worker/D1/session state, visible Bot creation/launch, composer queue/retry and human approval. Named-session review/PR panels are checked. Only execution is synthetic and GitHub is a local mock. |
| Desktop real local-daemon execution | PASS: 9 UI steps + 12 protocol checks | Actual Bot form, thread, local computer selection, composer task, human task/tool approval, native Git/file edit, persisted diff and run-owned process cancellation. Only the model CLI is a deterministic fixture. |
| Desktop boundary | PASS | Electron 44.7.0, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, native desktop bridge present, renderer `require` undefined, and no `--no-sandbox` launch argument. |
| Exact-ID fixture cleanup | PASS | The lifecycle's own session and custom-agent records were removed with HTTP 200. |
| Native macOS execution, signing, notarization, release installation | NOT VERIFIED here | The current cloud host is Linux. A macOS CI gate is configured separately; adding that gate does not establish it has run or passed. |

The lifecycle checks create and edit a Bot, reload its settings, launch/reopen its thread, submit through the real composer, recover from an injected 503 with the same command ID, and verify the exact session/configuration frozen before approval. They edit the profile before clicking Approve and assert that the completed synthetic run retains the earlier version, instructions and model. They also inspect the visible version badge, archive/restore history, and correctly scoped review/PR panels without a false missing-run error. Successful Bot submission no longer uses an API queue seam.

The shell/harness suite passed all 5 tests. After the final Bot and session-routing changes, all 11 actual-dashboard checks and the separate real local-daemon journey passed in Electron. No live provider calls, external messages, real GitHub publications, deployments, or release publication occurred.

## Artifacts

The current instance retains ignored evidence:

- `.verify/desktop-agent-lifecycle/result.json`: all 11 checks, composer UI submission, frozen approval/run data, scoped panel statuses, native bridge/sandbox properties, Electron version, platform, and cleanup statuses.
- `.verify/desktop-agent-lifecycle/trace.zip`: the real desktop dashboard journey.
- `.verify/desktop-agent-lifecycle/pending-approval.png`, `completed-profile-run.png`, and `restored-agent-history.png`.
- `.verify/desktop-shell/interactive-setup.png`: the native setup submission regression against a local HTML fixture.
- `/tmp/shiba-desktop-e2e-final.log`, `/tmp/shiba-desktop-agent-lifecycle.log`, and `/tmp/shiba-desktop-typecheck-final.log`.
- `/tmp/shiba-desktop-e2e-final-current.log`: a further 5/5 Electron rerun after the final local-daemon process-group changes.
- `/tmp/shiba-scoped-bots-desktop.log`: final 11/11 Bot lifecycle refresh.
- `.verify/local-daemon-e2e/ui-desktop/evidence.json`, `completed-local-bot.png`, and `completed-local-diff.png`: real local-daemon journey with the model boundary labeled as a fixture. Log: `/tmp/shiba-ui-local-desktop.log`.

## macOS target and remaining acceptance

The user selected macOS as the laptop target. `.github/workflows/desktop.yml` now runs the shell tests, actual-dashboard lifecycle, and unsigned DMG/ZIP packaging on `macos-latest`, including manual dispatch. Desktop tag release jobs depend on that verification job. Installer and test evidence are uploaded even on failure. The updater's repository target is `opentoolsorg/shiba`. No workflow was pushed or run, and no release was published from this session; this is a prepared Mac gate, not a passing Mac result.

The final full repository suite passed **3,148 tests with 3 credential-dependent tests skipped**; all 10 workspace typecheck tasks, all 6 build tasks, docs/output verification, CI checks and import lint passed. CI lint still reports warnings and existing Knip findings within the repository threshold. Logs are listed in the [main audit](overlay-parity-audit.md).

The real Worker/local-daemon journey passed [9 UI steps and 12 protocol checks in both web and Electron](local-runtime.md), including approval-gated file edits, scoped diff display and cancellation with a fixture model CLI. This instance has no ready model-provider connection, so live inference, provider authentication and production OAuth remain unverified. Native Mac execution, installer launch, deep links, signing and notarization require a Mac runner/device.

The requested `reasonmachines.com` reference returned proxy CONNECT 403 before the site could be read. `reasonmachines.com` and `www.reasonmachines.com` were saved to the environment draft's network domains; draft persistence does not apply or publish the policy. No feature comparison against that inaccessible site is asserted.

## Reproduction on this Linux cloud host

The environment's saved setup instructions retain helper files outside the repository. Run these from `/workspace/shiba`:

```bash
source /workspace/.tools/shiba-env.sh
bash /workspace/.tools/setup-desktop-runtime.sh
source /workspace/.tools/desktop-env.sh
bash /workspace/.tools/start-desktop-display.sh
pnpm -C apps/desktop test:e2e
```

`setup-desktop-runtime.sh` downloads the pinned official Electron archive when absent and verifies it against the official release checksum before extraction. The verified Linux archive SHA256 is `3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a`. Xvfb is downloaded and extracted into workspace storage using apt's signed Debian metadata and the distro archive keyring. No TLS, checksum, or package-signature verification is disabled. Reinstallation/refresh and both fresh-start and already-running display paths were tested.

The renderer sandbox requires Linux namespace support. Earlier restricted execution mounted `/proc/self/uid_map` read-only; automatic review allowed sandbox-preserving execution then. The final local-daemon Electron run used the root task's unrestricted execution profile normally, without an escalation flag. Follow the current tool permission profile. The command uses the installed, root-owned mode-4755 `/usr/lib/chromium/chrome-sandbox` through `CHROME_DEVEL_SANDBOX`; no system ownership or permissions were changed. Tests explicitly enable Playwright's `chromiumSandbox` because Playwright otherwise disables it on Linux. An initial run with Playwright's default was discarded and is not counted.

For the actual dashboard lifecycle, launch the existing mock Worker harness with containers disabled, mock GitHub, and the stand-in enabled. Use that launcher's same `VERIFY_DIR` and recorded port:

```bash
VERIFY_DIR=/workspace/shiba/.verify/desktop-runtime \
VERIFY_AGENT_LIFECYCLE_MOCK=1 VERIFY_DESKTOP=1 \
VERIFY_APP_URL=http://127.0.0.1:8790 \
node .cursor/skills/verify-shiba/scripts/drive-agent-lifecycle.mjs
```

The command rejects a target that does not match the recorded local mock Worker port. The desktop adapter launches the built `apps/desktop/dist/main.js` with fresh temporary user-data and run directories, verifies the native boundary before proceeding, records separate desktop artifacts, and closes the application and temporary files afterwards. `VERIFY_DESKTOP` is a test-driver choice, not a production application feature flag.
