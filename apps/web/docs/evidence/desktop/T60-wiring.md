# T60 wave 2 — main.ts integration wiring (worker-2, task 9)

## Files
- New: apps/desktop/src/controller.ts (electron-free probe/daemon state machine, §3.4), test/controller.test.ts (19 tests)
- Edited: apps/desktop/src/main.ts (wiring); minimal fixes in supervisor.ts + tray.ts (removed `eslint-disable @typescript-eslint/no-require-imports` comments: rule isn't loaded in the root flat config so ESLint errored "Definition for rule not found")

## Wired in main.ts
1 config (fs, unchanged) · 2 captureShellEnv -> sanitized env, runRoot = SHIBA_LOCAL_RUN_ROOT || ~/.shiba-local · 3 probe GET /api/computers via session.fetch(credentials include, redirect manual): 401/3xx/0/network -> signed-out (60s + did-navigate re-probe), 404 -> disabled+stop, 200 no config -> unpaired, workerUrl origin mismatch -> paired-elsewhere, else fork; 405/5xx keep state + retry 60s (§3.4 table) · 4 supervisor messages -> idle/busy/offline, exit policy via createRestartPolicy (restart args [], revoked/conflict/crashed, pairing fork pre-polling exit -> re-probe) · 5 tray (all ids from tray.ts; Connect opens /app/?tab=remote, Disconnect = revoke+stop+rm config) · 6 registerDesktopIpc with real deps · 7 approvals poller (own probe, notifications toggle) · 8 handleDaemonMessage on settled · 9 startUpdater (packaged only) · 10 powerMonitor suspend/resume · 11 quit-while-busy confirm -> stop (QUIT_WAIT_MS) -> app.exit(0) · 12 main.log + daemon.log via logs.ts

## Checks (apps/desktop)
- typecheck clean; vitest 8 files / 102 tests pass; eslint clean; build ok
- Greps: no createServer/.listen anywhere in src; only POST in main.ts is /api/computers/revoke (tray Disconnect, mirrors pairing.ts unpair); no POST /api/approvals (poller only GETs)
- IPC: status/pair/unpair check isTrustedSender (pairing.ts); desktop:set-url handled in main.ts with isSetupSender (pairing.ts's own set-url registration is filtered out in main.ts)

## Notes / unverified
- Not run under a live Electron window; no real deployment/login (STOP-A).
- assets/trayTemplate.png absent (worker-6): tray is skipped with a log line until it exists.
- Tray Connect only opens the dashboard Remote tab (pairing token is minted by the renderer button).
- `openAsHidden` is not in Electron 44 types, so login item sets openAtLogin only.
- Daemon exit 143/130 not initiated by the app shows state offline ("daemon stopped").
- Root eslint config doesn't ignore apps/desktop/dist; lint passes only because dist is rebuilt clean.

## REVIEW1 fixes (F1–F3)
- F1: pairing.ts is the single owner of `desktop:set-url`; main.ts no longer registers it or filters the channel (grep: no `ipcMain.handle` left in main.ts).
- F2: pairing.ts checks the sender via new dep `isSetupSender` (main binds navigation.ts#isSetupSender to the bundled SETUP_URL); the file:// suffix check is gone.
- F3: pairing.ts `validDeploymentUrl` removed; new dep `parseDeploymentUrl` (main binds `app.isPackaged`). `onSetUrl` now receives the reduced origin and may return a PairResult.
- Tests: pairing.test.ts updated + 2 new cases (foreign setup.html path rejected, packaged rejects http loopback, onSetUrl result passthrough). Desktop suite 104 pass; typecheck, eslint, build clean.
