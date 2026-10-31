# Cloud integration verification — 2026-10-31

The preserved onboarding/context integration is verified on **Linux x86_64 in the cloud**. The user's Mac was not accessed. This is a tested development checkpoint for PR163, not proof that the entire product roadmap or a live deployment is complete.

## Source and integration

Application verification ran on frozen source `08642868bc25f46c771c9bc84731acb108da2839`. Acceptance records the same starting and finishing revision with `dirtyHarnessChangesIncluded: false` in [evidence.latest.json](../../apps/backend/test/acceptance/evidence.latest.json).

The integration preserves the primary handoff `e29b7e6` and concurrent PR163 commit `70bc03f`, then incorporates the UI30, MCP470/MCP90 and native759 follow-ups individually. The projects CAS work-in-progress remains preserved on its transfer branch; it is not included in this checkpoint.

After application validation, `81a0885` changes only three verification drivers: eight added lines and one removed line explicitly choose Work mode and open Advanced settings. Their mock-loop gate passed. No application source changed after the frozen application revision. This report and the acceptance JSON are delivery evidence, not another application change.

## Results

| Gate | Result and boundary |
| --- | --- |
| Full package suite | **4,015 passed; 3 live TypeSafe tests skipped**, across all eight test packages. Backend: 3,372; frontend: 381; desktop unit: 200. Fresh uncached suites, bounded to two workers and one package at a time. |
| Build/docs | All six build tasks passed; 62 HTML pages and 3,756 local links/assets/anchors verified. |
| Types and code checks | All ten typecheck tasks and SDK generated-type parity passed. Lint, import lint and `check:ci` passed with existing warnings/Knip findings; this is not a warning-free claim. |
| Configuration | Deployment/env parity and dev-vars documentation checks passed. Actual Varlock rejected missing, uppercase, short and nonhex account IDs and accepted a synthetic valid ID. No account was provisioned. |
| Deterministic acceptance | **16 journeys passed; one live-provider/container journey blocked.** |
| Actual Chromium + Worker/DO/D1/R2 | **21 browser checkpoints passed**, including managed upload, version conflict/retry, citations, disable/forget, isolation between distinct authenticated owners, frozen goal approval, exact artifact bytes/hash, and human acceptance of that exact goal. Models and execution use declared deterministic fixtures. |
| Linux Electron | **9 tests passed across four files**, including the actual shared React UI and isolated Worker/storage through process restarts, unsent answer, prepared goal/version, named thread, approved fixture output, review and final retained-output restart. Shell/harness checks use local fixtures. |
| Self-host smoke | Passed fresh local migrations, setup JSON and built dashboard boot with containers disabled. The isolated Corepack cache was populated from the already-verified pinned pnpm installation when direct DNS download was unavailable. |
| Recovery drill | Passed actual stopped local Wrangler DO/D1/R2 backup, integrity checking, restore and rollback. Included in the backend count. SQLite CLI and complete local process inspection were required; the offline safeguard remains fail-closed. |
| Additional helper/built checks | Seven managed-context verifier tests and the built marketing-page test passed. |
| Mock-loop verification | **11 core-loop assertions, 9 browser thread steps and 11 Electron Bot lifecycle steps passed.** Core-loop approval is explicitly API-driven; Bot lifecycle submission/approval uses UI. GitHub and execution are local mocks. Exact fixture record cleanup returned HTTP 200. |

## Changes found during cloud verification

- Completed current-goal `employee_context_read`/retention discovery while keeping connector discovery/calls grant-bound. Unprepared/stale contexts and ordinary legacy/no-profile turns do not acquire the new context tool.
- Setup's source-management action opens the Workspace Memory source manager.
- Desktop shutdown finishes through `app.quit()` after stopping its daemon, allowing normal Electron storage/session cleanup. The native journey verifies an unsent answer is in browser storage before closing and survives restart.
- Acceptance follows the actual owning thread and exact artifact for downloads and review. Native polling awaits bounded renderer recovery and asynchronous result projection, with explicit terminal-error diagnostics. These changes retain the production approval and artifact-workspace/local-runtime guards.
- Preserved the trusted stored-session draft ownership fix, callback-only chat error recovery and explicit deployment-account validation from the handoff/concurrent work.

## Evidence and remaining limits

Ignored cloud artifacts are under `.verify/cloud/`, `.verify/native-onboarding/`, `.verify/agent-threads/`, `.verify/desktop-agent-lifecycle/` and `.verify/evidence/ci-local-20261031T100212Z/`. The latter records Electron 44.7.0, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and an isolated renderer/native bridge.

The browser transport fault proves callback-style chat failure with a resolved send promise restores the draft and preserves newer text. A thrown-send App-level error, a session switch during that send, and a same-text newer-goal selection are not separately browser-injected in this checkpoint. Managed-context citation proof establishes provenance, exact bytes/hash and literal citation presence; semantic citation validation remains false.

Live model/provider calls, OAuth login, real Gmail/Slack/Reason sends or joins, real sandbox execution, Cloudflare provisioning/deployment and real GitHub publication from fixture runs were not performed. Deployment account/hostname selection remains pending. No PR metadata, validation label, review-thread resolution, release or merge is part of this checkpoint.

Linux does not prove macOS tray/notifications, Keychain, login items, protocol registration, signing, notarization, Gatekeeper or installer launch. These checks must not return to the user's Mac under the current restriction.

The original roadmap still includes project CAS consumers/authority/links/pins, artifact collection/read authority, reconnect/resync, serialized budget reservation/settlement, shared tenant ACLs, richer artifact handlers and operational retention/deletion. A full browser/model journey for repository-free supplied-facts drafting remains unverified. See the [preserved handoff](2026-10-31-cloud-handoff.md) for scope and branch details.
