# Local Worker and laptop daemon acceptance

See the [final recheck](final-recheck.md) for the current **3,342 passed,
3 skipped** repository suite, same-state local cleanup migration and latest
web/Electron evidence. Earlier counts and run IDs below are historical.

Validated on Linux on 2026-10-28. The real Worker, Durable Objects, D1 authentication, pairing, daemon, Git, approvals, file collection, diff persistence, and cancellation were exercised together. The Claude model CLI was a deterministic fixture that spoke the real stream-JSON protocol. This does not establish live model inference or native macOS application execution.

## Executed acceptance path

The tracked driver is `.cursor/skills/verify-shiba/scripts/drive-local-runtime.mjs`. It refuses non-loopback Worker URLs. It ran against an isolated Worker on port 8794 with its own ignored environment file and persistence directory; the main development Worker and its configuration were unchanged.

| Check | Result | Evidence |
| --- | --- | --- |
| Dashboard identity | PASS | Real local Better Auth sign-up/session, with same-origin requests. |
| Daemon pairing | PASS | Dashboard minted a one-time pairing token; the actual daemon redeemed it and stored its machine credential in a disposable operator profile. |
| Machine discovery | PASS | Real heartbeat appeared in `/api/computers` with the discovered Claude executable. |
| Human task approval | PASS | Queueing created a pending approval and no run; approval then reserved and dispatched the local run. |
| Repository execution | PASS | Native Git cloned a temporary repository. An isolated operator Git configuration rewrote only the fixture repository URL; no real GitHub mutation or fake Git executable was involved. |
| Real daemon claim | PASS | The daemon claimed the Worker mailbox record and executed the frozen local envelope. |
| Tool permission | PASS | The fixture CLI requested a Write permission through the actual Claude session protocol; the file remained unchanged until the dashboard harness approval was allowed. |
| Frozen bot provenance | PASS | Version 1 and the profile instructions reached execution and remained on the persisted run. CLI arguments used the `default` Claude permission mode (`approval-required` in the envelope). |
| File edit and diff | PASS | The approved fixture CLI changed `README.md`; the completed Worker run contained the actual diff after native Git collection. |
| Cancellation | PASS | Dashboard cancellation reached the running CLI and its terminal run stayed cancelled. |
| Tool subprocess cleanup | PASS | A child tool wrote a sentinel repeatedly; after cancellation, its sentinel stopped changing. The process belonged to the daemon-created session process group. |
| Terminal fencing | PASS | Cancellation was not replaced by a late daemon result. |

Initial protocol-only completed run: `agent-tool:537d63f1-c3a0-4d25-a957-6f4e82c39ab1`.
Initial protocol-only cancelled run: `agent-tool:9e67f19b-ef62-4fc8-a03d-93a22b7e4a92`.
Machine-readable evidence: `.verify/local-daemon-e2e/evidence.json` (ignored local test output; contains no real credentials).

## Final Bot UI acceptance

After the Bot launch and named-session fixes, the same real Worker/daemon
journey passed in **both the browser and sandbox-enabled Electron**. Each
target completed **9 UI steps plus all 12 protocol checks** above:

- Create bot through the real form, then Launch bot into its bound thread.
- Select the actual paired computer and Send task through the composer.
- Read back the frozen profile version, local runtime, machine and owning
  session; verify that queueing has not started execution.
- Click the actual task Approve and tool Allow buttons before the file edit.
- Reopen the completed versioned run and inspect its actual native Git diff.
- Verify the review request carries the same session, returns HTTP 200, and
  settles without a false missing-run error.
- Compare the displayed patch byte for byte with the persisted Git diff and
  reject protocol-envelope metadata. The web target also clicks the actual
  `.diff` download and verifies the exported 153 bytes match exactly.
- Queue and approve a second task, cancel it through the real dashboard API,
  and prove the CLI/tool child stop while terminal status remains cancelled.

Current evidence is `.verify/local-daemon-e2e/ui-web/evidence.json` and
`ui-desktop/evidence.json`. Both explicitly record the deterministic fixture
Claude CLI and `liveInference: false`; pairing, the Worker, daemon, native Git,
permission gating, file edits and persistence are real. The desktop result
records Linux, Electron 44.7.0, the native bridge, no renderer `require`,
`sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
Screenshots `completed-local-bot.png` and `completed-local-diff.png` are saved
beside each result. Logs: `/tmp/shiba-ui-local-{web,desktop}.log`.

The final desktop completed run is
`agent-tool:f21da2de-fc11-4604-a59a-6323989d4408`; its cancelled run is
`agent-tool:af05fc97-d9a8-49b6-9737-c9eaa056b784`. Only returned fixture IDs
and isolated state were used. The driver replaces old evidence with RUNNING
at startup and FAIL on exceptions; a deliberate connection failure verified
that it cannot leave a stale PASS. All driver-owned daemons/browser processes
stopped, and the isolated Worker on 8794 was stopped and its port checked closed.

Additional fixes found by this UI acceptance derive dashboard approval thread
keys from verified user/session routing, keep personal/named approval decisions
on their owning store, select real fleet machines without a fabricated bridge,
and reject invalid, unpaired, revoked, stale or incompatible pinned targets.
Retained diffs now take precedence over tool-summary fallbacks; legacy summary
extraction stops at the exact unprefixed result marker without truncating real
added, removed or context lines. Thirteen focused extraction tests passed.
Focused ownership tests passed **62 cases**; local dispatch/fleet tests passed
**65 cases**. The final full repository suite passed **3,148 tests, 3 skipped**.

To run the UI driver again, prepare the same isolated Worker configuration
described below, rebuild assets **before** starting/restarting that Worker, and
run the tracked command. Set `VERIFY_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`
on this cloud host. For Electron also activate the desktop environment/display
and set `VERIFY_DESKTOP=1`; follow the current execution permission profile.
Rebuilding assets while an older Wrangler manifest is retained can require
restarting only that owned test Worker.

## Bugs found and fixed

- The daemon swallowed 409 responses from its control poll after the Worker cancelled and invalidated the claim. Local CLI execution could continue. A bounded monitor now stops work on revoked, missing, or cancelled claims and also handles the older argv execution path.
- Session execution did not enforce the envelope deadline. The monitor now enforces the deadline; argv timeout results report the deadline explicitly.
- A late control response from a completed run could target the next run's global child. Execution completion now fences in-flight monitor callbacks. A deterministic two-run test delays the old claim's 409 until the next CLI is active and verifies both intended runs finish.
- Stopping only the CLI left its normal tool subprocesses alive. Unix/macOS daemon CLI children now opt into dedicated process groups; cancellation/deadline/revocation and CLI exit clean only recorded run-owned groups. Session-layer callers outside the daemon keep their existing spawning behavior. Tests also verify that an unrelated operator process survives.
- The module-global signal array leaked prior tasks' receipts into later results. It now resets for each execution. The two-run regression verifies a second task cannot inherit the first task's exec evidence.
- The credential allowlist recognized `claude` while actual envelopes name `claude-code`. Canonical Claude/Codex harness names now map to the appropriate provider key allowlist, retaining exclusion of daemon/GitHub/unrelated credentials.
- Fast runs could settle between Worker polls, losing the `local.claimed` milestone. A settled record's persisted `claimedAt` now preserves this actual claim evidence.
- The local envelope dropped bot identity/version/org. Optional provenance fields now cross the shared envelope schema and adapter unchanged.

## Verification

```sh
source /workspace/.tools/shiba-env.sh
pnpm -C apps/backend test \
  test/local-daemon-control.test.ts \
  test/local-daemon.test.ts \
  test/local-runtime.test.ts \
  test/agent-harness.test.ts --maxWorkers=2
pnpm -C apps/backend typecheck
```

Result: **59 tests passed in 4 files**; backend source and test TypeScript checks passed. The session-source synchronization test also passed after intentionally regenerating `apps/backend/src/harness/agent-harness-source.ts` from `scripts/agent-harness.mjs`.

To repeat the real Worker fixture, start a separate local Worker using an **absolute** `--env-file` path, `--local --enable-containers=false`, an isolated `--persist-to` directory, and locally generated `PAIRING_SECRET`, `BETTER_AUTH_SECRET` (32+ characters), and `INTERNAL_SIGNING_KEY`. Set `SHIBA_LOCAL_RUNTIME=1` and `BETTER_AUTH_URL` to that local origin. Keep remote provider credentials absent. Then run:

```sh
node .cursor/skills/verify-shiba/scripts/drive-local-runtime.mjs
```

`VERIFY_LOCAL_WORKER_URL` selects another loopback origin. The driver creates only disposable local account/profile/session data and a temporary operator/Git fixture. Generated fixture account credentials live only in ignored local test files, not source or the evidence JSON. Use a dedicated Worker state directory, since production-style sign-up permits only the first account.

## Cleanup and remaining limits

The driver stopped its daemon and run-owned children. The isolated Worker on 8794 was then stopped and the port was checked closed. Temporary Git/operator fixtures and ignored local Worker state/evidence remain available for inspection. The tracked checkout was not used as the daemon's task repository, and no real provider credential, external message, or PR was used.

This is Linux protocol evidence. Native macOS signing, packaging, deep-link delivery, launch-agent behavior, and actual model authentication require their own platform acceptance checks. Unix process-group cleanup covers tools that remain in the run's group; deliberately detached processes are outside that mechanism. Windows process-tree cancellation was not established by this test.
