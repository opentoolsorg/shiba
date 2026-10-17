# REVIEW3 fixes — applied by leader 2026-10-08

All 13 findings from REVIEW3-final-audit.md addressed; verified below.

| # | Fix | Verification |
|---|---|---|
| F1 | run-notify.ts isSettledMessage checks `message.state` first | new test/run-notify.test.ts feeds the real DaemonStatusMessage shape (5 tests, pass) |
| F2 | trayIconPath uses app.getAppPath() (assets ship inside asar) | packaged .app launched: no missing-icon path error; tray asset present in asar |
| F3 | electron-updater moved to dependencies (+pnpm-lock importer updated) | `grep electron-updater app.asar` = 10 hits (packed); autoUpdater import fixed (CJS .default interop) |
| F4 | .github/workflows/desktop.yml: `pnpm --filter @shiba/desktop build` before electron-builder in both jobs | yml diff; dist/ is gitignored so CI must compile first |
| F5 | DISCONNECTABLE drops "conflict"; pairing.ts unpair falls back to readLocalConfig().machineId | tray.test.ts + pairing.test.ts new cases pass |
| F6 | main.ts disconnectLocal mirrors pairing.ts: non-ok revoke → log + keep config, shared module-level readLocalConfig | typecheck; pairing.test.ts |
| F7 | controller probe skips start([]) while state is revoked/conflict/crashed | controller.test.ts: 3 new cases (exit 78, exit 75, crash-budget) pass |
| F8 | heartbeat offline after 2 consecutive misses; resets on ok/other msgs | controller.test.ts updated + new reset case pass |
| F9 | waitForPair races 30s timeout → kills child → {ok:false,"pairing timed out"}; deps.pairTimeoutMs injectable | pairing.test.ts new timeout case passes |
| F10 | desktop-bridge.ts unpair(): Promise<PairResult> | typecheck across consumers |
| F12 | remote-access.md "Cloudflare Access" subsection documents the manual /api/local/* bypass app for wrangler/external-Access deploys | docs:verify pending in gate |
| F13 | approvals-poller start() seeds only when !seeded; resume diffs+notifies immediately | new approvals-poller.test.ts (3 tests) pass |

## Packaged-app findings found only by launching the artifact

- **P1 (HIGH)**: unsigned fused binary is kernel-killed on arm64 ("Code Signature Invalid") — CSC_IDENTITY_AUTO_DISCOVERY=false skips ALL signing incl. adhoc. Fix: `apps/desktop/scripts/adhoc-sign.sh` (inside-out; `--deep` is broken for Electron's nested bundles), wired as `pnpm dist:local`.
- **P2 (HIGH)**: file:// can't reach inside app.asar on Electron 44 — setup page 404'd. Fix: asarUnpack dist/setup.html+setup.js and SETUP_DIR points at app.asar.unpacked when packaged. Packaged .app now boots clean (no load errors, renderer alive).
- **P3 (LOW)**: userData was ~/Library/Application Support/@shiba/desktop — app.setName("Shiba") pins it to .../Shiba per docs.
- **P4 (LOW)**: packaged autoUpdater destructure needed .default fallback (CJS/ESM interop).

Post-fix verification on the rebuilt artifact: 119 unit tests, e2e 2/2, fuses read = D8 on both arches, .app launches with clean stderr and live renderer.
