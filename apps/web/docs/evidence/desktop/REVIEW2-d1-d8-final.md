# REVIEW2 — D1–D8 final pass on wired main.ts

Reviewer: worker-4 · task 13 · read-only. Scope: apps/desktop/src/{main,pairing,preload,tray,supervisor,controller,approvals-poller,run-notify,updater,navigation,logs}.ts + setup.js + electron-builder.yml + scripts/shiba-local-daemon.mjs diff.

## IPC channel → sender check (re-check #1)

| Channel | File:line | Check |
| --- | --- | --- |
| desktop:status | pairing.ts:120-122 | trusted() → isTrustedSender(frame.url, configuredOrigin) |
| desktop:pair | pairing.ts:125-127 | trusted() |
| desktop:unpair | pairing.ts:146-148 | trusted() |
| desktop:set-url | pairing.ts:164-166 | deps.isSetupSender bound to exact SETUP_URL (main.ts:340) |

Exactly ONE ipcMain.handle per channel; registerDesktopIpc is the single registration site (main.ts:336-365). No ipcMain.handle remains in main.ts itself.

## REVIEW1 findings — resolution

| # | Severity | Status |
| --- | --- | --- |
| F1 duplicate desktop:set-url | MEDIUM | FIXED — registerSetupIpc removed; single handler in pairing.ts |
| F2 file:// suffix check | LOW | FIXED — handler now uses isSetupSender exact-path (pairing.ts:165) |
| F3 validDeploymentUrl ignores packaged | LOW | FIXED — handler uses deps.parseDeploymentUrl bound with app.isPackaged (pairing.ts:167, main.ts:341) |
| F4/F5/F6 | INFO | unchanged — see notes |

## D1–D8 verdicts (wired tree)

| Inv | Verdict | Evidence |
| --- | --- | --- |
| D1 | PASS | No POST /api/approvals (grep clean; approvalsUrl is GET-polled only, main.ts:239). Clicks load only ?tab=approvals / ?tab=activity / ?tab=remote / /app/ (main.ts:240,291-293, run-notify.ts:11). Sole POST is /api/computers/revoke (pairing.ts:151, main.ts:270) — fleet revoke, not approval mutation. |
| D2 | PASS | createServer/.listen grep clean across src + daemon. |
| D3 | PASS | desktop:pair forks ["--connect", origin, "--pair", token] with origin from getConfiguredOrigin() (pairing.ts:142); token regex blocks flag injection (:69,130-134); argv form, no shell. |
| D4 | PASS | preload origin-gates shibaDesktop on --shiba-origin= (preload.ts:4-8); shibaSetup only on bundled setup.html (:21); every handler re-checks senderFrame (table above); additionalArguments fixed at window creation, recreateWindow() on URL change (main.ts:148,182-187). |
| D5 | PASS | sandbox/contextIsolation/nodeIntegration:false/webviewTag:false (main.ts:141-149); will-attach-webview prevented (:114). |
| D6 | PASS | decideNavigation + will-navigate + will-redirect + setWindowOpenHandler all wired (main.ts:104-118). |
| D7 | PASS | shellEnv flows through captureShellEnv→sanitize (main.ts:384,401; shell-env.ts:7,24-30) dropping SHIBA_WORKER_URL/LOCAL_ADAPTER_TOKEN/NODE_OPTIONS/ELECTRON_*; pairing token reaches only daemon argv; notifications are fixed title + repoSlug or fixed email-kind labels; daemon report() payloads carry no token. |
| D8 | PASS (static) | electron-builder.yml unchanged — exact 7 fuses, hardenedRuntime, notarize:true. Binary-level fuse verification (`@electron/fuses read`) is worker-6's task 12. Permission handlers: request+check allow only clipboard-sanitized-write for isTrustedSender(url, configuredOrigin()) on the shared defaultSession (main.ts:207-214). |

## New-wave checks (re-check #8)

- Quit-while-busy: onBeforeQuit → confirm only when shouldConfirmQuit(state==="busy") → shutdownStarted → poller.stop → controller.stop() (SIGTERM + resolves on child exit OR QUIT_WAIT_MS=5s timer — no deadlock path) → dispose/tray.destroy/app.exit (main.ts:419-442, controller.ts:116-127, supervisor.ts:49). Daemon's own 3s settle budget fits inside QUIT_WAIT_MS. PASS.
- Updater: startUpdater no-ops when !isPackaged (updater.ts:25); interval+errors logged not thrown. PASS.
- Probe: sessionFetch forces credentials:"include", redirect:"manual" (main.ts:216-217); controller maps 404→disabled, 401/3xx/network→signed-out, 405/5xx→retry-in-60s, 200+unpaired→unpaired / paired-elsewhere by origin compare / paired→start daemon (controller.ts:140-163). PASS.
- Supervisor env sanitize: confirmed — forkDaemon env is the sanitized shellEnv only (main.ts:384).

## New findings

- N1 — INFO — tray "Check for updates" (main.ts:308) calls autoUpdater even unpackaged; failure is caught+logged, harmless.
- N2 — INFO — daemon stdout/stderr chunks land verbatim in daemon.log via controller.ts:108; safe only while the daemon never echoes argv/token (carried from REVIEW1 F4).
- N3 — INFO — F6 double result post (SIGTERM between execute-finish and loop post) remains; second post rejected by single-use claimToken. Harmless.

## Verdict
D1–D8 hold on the wired tree. 0 open MEDIUM/LOW; 3 INFO notes. Remaining proof: binary fuse read + live Access deploy checks (tasks 12/T66).
