# T64+T65 static — worker-6 evidence

## Files changed
- apps/desktop/src/approvals-poller.ts — probe-gated (own GET /api/approvals gate, §3.4) 30s poller; silent seed; per-new-approval notify; start/stop/toggle/isRunning for tray + powerMonitor. Electron fully injected — file is pure TS, testable under Node.
- apps/desktop/src/run-notify.ts — settled -> "Local run finished" + repoSlug; click -> <origin>/app/?tab=activity. Never says "completed" (§11.7); never a ?run= link.
- apps/desktop/src/updater.ts — checkForUpdatesAndNotify at launch + every 6h, only when packaged; errors logged, never thrown.
- apps/desktop/electron-builder.yml — appId com.shiba.desktop, productName Shiba, output release/, files [dist/**, assets/**], extraResources daemon outside asar, electronFuses per D8 (runAsNode:false, NodeOptions:false, CliInspect:false, CookieEncryption:true, onlyLoadAppFromAsar:true, AsarIntegrity:true, grantFileProtocolExtraPrivileges:false), mac dmg+zip arm64+x64 hardenedRuntime notarize:true, publish github princepal9120/ai-intern draft.
- .github/workflows/desktop.yml — PRs touching apps/desktop/** | scripts/shiba-local-daemon.mjs | packages/shared/src/desktop-bridge.ts | this file -> macos-latest: install, typecheck, lint, test, unsigned electron-builder --publish never (CSC_IDENTITY_AUTO_DISCOVERY=false), upload dmg. desktop-v* tags -> signed+notarized draft release; secrets env-only, added by human.
- apps/desktop/test/smoke.e2e.ts — playwright-core _electron.launch: body renders, bridge present + typeof require === "undefined" (D4/D5), example.com nav rejected (D6). Runs via test:e2e (vitest.e2e.config.ts exists), not in pnpm test.
- .gitignore — added release/ (shared file, minimal append per ground rule 4).
- biome.json — added !**/release (shared file, minimal append; de-duped a second identical line another lane added concurrently).

## D-invariants enforced
- D1: poller/notify modules contain no approval POST; click handlers only loadURL(<origin>/app/?tab=approvals) or /app/?tab=activity (approvals-poller.ts openApprovals, run-notify.ts handleDaemonMessage).
- D7: email_send/email_delete bodies are fixed labels "Email send"/"Email delete" — repoUrl mailbox address never rendered (approvals-poller.ts approvalNotificationBody). Notifications carry title + owner/repo only.
- D8: electron-builder.yml electronFuses block = exact D8 list; hardenedRuntime + notarize on mac targets.
- D2/D5/D6: no listeners; smoke.e2e.ts asserts require undefined and external-nav denial.

## Checks run
- tsc --noEmit --strict --module nodenext on the 3 src modules: PASS (exit 0).
- biome check (lint) on my 4 files: PASS, 0 findings.
- pnpm --filter @shiba/desktop typecheck: FAIL — but all errors are in worker-2's in-flight scaffold (main.ts implicit-any, electron/@shiba/shared unresolved because that lane's deps/tsconfig aren't finished). Zero errors in my files.
- actionlint: not installed; workflow syntax hand-checked against ci.yml conventions.

## Unverified / notes for leader
- electron-builder dist, fuses read, and the e2e run are STOP-C / leader gate per assignment.
- smoke.e2e.ts assumes entry dist/main.js and that the packaged/served window lands on an app-origin page where window.shibaDesktop exists; if T60's setup flow needs a URL-set step before /app/ loads, the test needs that interaction added by the integration lane.
- My modules take injected deps; main.ts wiring (session.defaultSession.fetch, Notification, tray toggle, powerMonitor pause/resume, supervisor daemon-message stream -> handleDaemonMessage) belongs to the scaffold/supervisor lanes.
- electron devDeps in package.json use ^ ranges — outside my scope (worker-2's file); flag for ground rule 9 exact-pin review.
