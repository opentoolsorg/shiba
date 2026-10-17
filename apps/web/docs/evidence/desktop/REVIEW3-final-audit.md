# REVIEW3: final adversarial audit, Shiba Desktop (T59–T66)

Reviewer: independent, read-only, Opus 5.5 · 2026-10-08. I wrote no source code.
Source of truth: DESKTOP-PLAN.md §3–§7. I re-checked everything below myself and did not rely on the earlier evidence files.

## What I ran myself

| Check | Result |
|---|---|
| `vitest run` in apps/desktop | 8 files, 104 tests pass |
| `pnpm --filter @shiba/desktop typecheck && lint` | clean |
| Fuse wire parsed straight from `release/mac-arm64/Shiba.app/.../Electron Framework` | RunAsNode off, CookieEncryption on, NodeOptions off, NodeCliInspect off, AsarIntegrity on, OnlyLoadAppFromAsar on, GrantFileProtocolExtraPrivileges off. **Matches D8.** |
| `app.asar` header listing | contains `dist/**`, `assets/**`, `node_modules/@shiba/shared`, `zod`. **No `electron-updater`.** `Contents/Resources/` has **no `assets/`** dir |
| `codesign -dv` on the .app | ad-hoc, `Identifier=Electron` (unsigned, as expected) |
| Release artifact timestamps | `.dmg` built 11:10, `src/main.ts` last edited 12:32. **The packaged app is stale relative to the current source.** |
| Grep of apps/desktop/src for `POST /api/approvals`, `createServer`, `listen(`, `localStorage`, `adapterToken` | none (the only `listen` is in test/smoke.e2e.ts's stub server, which is test-only) |
| `actionlint` | not installed |
| Full root gate / `check:ci` / e2e smoke / live Electron run | **not run** (no evidence anywhere that e2e has ever run) |

## T59–T66 Done-when → status

| Task | Done-when item | Status | Proof |
|---|---|---|---|
| T59 | GOAL item 15 | VERIFIED | spec/GOAL.md:31 |
| T59 | ADR with Context/Options/Decision/Consequences | VERIFIED | apps/web/docs/adr/0001-desktop-shell-electron.md:3,9,16,21 |
| T59 | PLAN §21 P11 + §2.0 rows | VERIFIED | PLAN.md:79-86, 1421 |
| T59 | `pnpm docs:verify` + gate | PARTIAL | docs:verify passed per T59-docs.md:9. VERIFICATION.md says the full gate was "not run" |
| T60 | `onlyBuiltDependencies: electron`, knip entry, `start` not `dev` | VERIFIED | pnpm-workspace.yaml:21; knip.json:29-31; apps/desktop/package.json scripts |
| T60 | `navigation.test.ts` table passes | VERIFIED | ran: pass |
| T60 | Window loads `/app/` and you can sign in (login spike) | GAP | Never launched. VERIFICATION.md says "Live Electron run: not run". Login spike is a placeholder |
| T60 | `.dev.vars.example` keys | VERIFIED | apps/backend/.dev.vars.example:55-57 |
| T61 | `/api/computers` uses `await isAuthorizedRequest` | VERIFIED | apps/backend/src/computers-routes.ts:69 |
| T61 | better-auth 200 test | VERIFIED (exists) | apps/backend/test/local-fleet.test.ts:206 |
| T61 | `/api/local/*` Access bypass + drift check (e) | VERIFIED | alchemy.run.ts:122; scripts/check-alchemy-drift.mjs:588 |
| T61 | daemon lock (`wx`, EEXIST→pid alive→75, dead→unlink retry once, sync unlink on exit) | VERIFIED | scripts/shiba-local-daemon.mjs:136-166 |
| T61 | graceful stop (kill child, 3s result POST, release lease, 143/130) | VERIFIED | shiba-local-daemon.mjs gracefulStop (end of file) |
| T61 | `daemon.test.ts`: second instance 75, lock gone after SIGTERM, `--help` without lock | VERIFIED | apps/desktop/test/daemon.test.ts:39-58 (real spawn, meaningful) |
| T61 | Manual Access-bypass equivalent for wrangler deploys documented in T66 docs | GAP | not in remote-access.md (grep finds no bypass instructions) |
| T62 | `desktop-bridge.ts` types | VERIFIED | packages/shared/src/desktop-bridge.ts; exported from index.ts:29 |
| T62 | supervisor tests: 78/75/143/1-backoff/budget | VERIFIED | test/supervisor.test.ts. Policy at supervisor.ts:32-43 |
| T62 | shell-env banner + forbidden-var tests | VERIFIED | test/shell-env.test.ts |
| T62 | Tray works in the shipped app | **GAP (HIGH, F2)** | main.ts:319 looks in `resourcesPath/assets`, which doesn't exist in the .app |
| T62 | Credential spike | GAP (manual) | VERIFICATION.md "not done" |
| T63 | preload origin gate | VERIFIED | preload.ts:7 |
| T63 | pair handler: sender check, token shape ≤1024, paired-elsewhere confirm, `--connect <origin>` | VERIFIED | pairing.ts:125-144 |
| T63 | unpair: revoke → stop → delete config | VERIFIED (renderer path) / PARTIAL (tray, F5/F6) | pairing.ts:146-161; main.ts:265-282 |
| T63 | RemoteAccessView "Connect this computer", "Add another computer", *This computer* marker; browser unchanged | VERIFIED (static) | RemoteAccessView.tsx diff; hidden when `bridge` is undefined |
| T63 | Composer "Run on" → `POST /api/runs` runtime:"local", local harnesses only, idle/busy only | VERIFIED (static) | app.tsx:330-337,796-815; TaskComposer.tsx:60,120,197 |
| T63 | Fresh machine pairs in one click, "This computer · idle" | GAP (manual) | never run |
| T64 | Approvals poller: own gate, 30s, silent seed, email-kind labels, click → approvals | VERIFIED (static) | approvals-poller.ts:24,42-51,121-151; main.ts:233-247 |
| T64 | "Local run finished" on `settled` | **GAP (HIGH, F1): never fires** | run-notify.ts:28 vs controller.ts:76-77 |
| T64 | Hidden window notifies within 30s, click lands on approvals | GAP (manual) | never run |
| T65 | electron-builder.yml (appId, files, extraResources daemon, fuses, dmg/zip arm64+x64, hardenedRuntime, publish draft) | VERIFIED | electron-builder.yml:4-37 |
| T65 | `fuses read` shows D8 | VERIFIED (by me, parsed from the binary) | see table above |
| T65 | unsigned `dist` → launchable .app **passes e2e smoke** | GAP | e2e never run, and it targets `dist/main.js` rather than the packaged .app. The artifact is stale |
| T65 | Updater at launch + every 6h, packaged only | **GAP (MED, F3)** | updater.ts is correct, but `electron-updater` is a devDependency and isn't in the asar |
| T65 | CI workflow | **GAP (HIGH, F4)** | .github/workflows/desktop.yml:30,54 run electron-builder with no `build` step first |
| T65 | `release` in .gitignore + biome ignore | VERIFIED | .gitignore:8; biome.json:13 |
| T65 | actionlint | GAP | not installed |
| T66 | smoke.e2e.ts checks setup/app/bridge/require/example.com | VERIFIED (written) / GAP (run) | test/smoke.e2e.ts:39-77 |
| T66 | Dated §7 acceptance entry | GAP (expected) | VERIFICATION.md:862-885 honestly says "local prototype" |
| T66 | Docs "Desktop app" section (install, first run, connect, tray, logs, Gatekeeper, uninstall) | VERIFIED | remote-access.md:75-126 |
| T66 | Separate D1–D8 security review | VERIFIED | REVIEW1, REVIEW2, and this file |

## D1–D8, re-verified independently

| Inv | Verdict | Notes |
|---|---|---|
| D1 | PASS | The only POSTs are `/api/computers/revoke` (pairing.ts:151, main.ts:270). Notification and tray clicks only `loadURL` app paths |
| D2 | PASS | No listener in src or daemon |
| D3 | PASS | argv is built in main from `getConfiguredOrigin()` (pairing.ts:142). The token regex blocks `--flag` injection, and there's no shell |
| D4 | PASS | All 4 `ipcMain.handle` calls are in pairing.ts:120,125,146,164, and each checks the sender. preload.ts:7 gates on origin. `setup` gate is an exact pathname match (navigation.ts:60-63). Drag-dropped `file:` navigations are denied by decideNavigation |
| D5 | PASS | main.ts:141-149, :114 |
| D6 | PASS (as specified) | Any `*.cloudflareaccess.com` tenant may load in-window (no bridge). Accepted by the plan |
| D7 | PASS | adapterToken is never read by the app. The pairing token goes only to argv. The daemon never echoes argv or the token (pair() prints machineId and path only). Notification bodies are a slug or a fixed label |
| D8 | PASS | Fuses verified in the binary. The permission handler allows only `clipboard-sanitized-write` on the origin (main.ts:207-214). Hardened runtime and notarization are config-only (unsigned) |

## Integration seams

- **pairing.ts DI ↔ main.ts.** Every required dep is passed (main.ts:337-364). `runRoot` is a getter, so it picks up the late shell-env value. The `forkDaemon` cast to `PairingDaemon` is structurally safe: a UtilityProcess has `on/once/stderr/kill`. ✓
- **Supervisor policy ↔ §3.4.** 78→revoked, 75→conflict, 130/143→stopped (none of them restart). A pairing fork with no `polling` → failed-pairing, no restart. Backoff is 1s·2^(n-1), capped at 60s, though the cap is never reached because the 5th exit trips crashed. The budget is 5 per 10-minute sliding window. The counter resets after a ≥10-minute healthy fork. Restarts use `start([])`, so `--pair` is never re-passed. ✓ (deviation: offline after 1 bad heartbeat, not 2. See F8)
- **preload ↔ ShibaDesktopBridge.** `version, status, pair, unpair, onStatus` match exactly. Small type drift: the `desktop:unpair` handler returns `PairResult` while the bridge declares `Promise<void>`, so a renderer caller can't see a revoke failure (F10).
- **Controller → run-notify: BROKEN** (F1).

## Findings (most severe first)

| # | Sev | Where | Problem | Fix |
|---|---|---|---|---|
| F1 | HIGH | apps/desktop/src/run-notify.ts:28 (fed by controller.ts:76-77) | `isSettledMessage` checks `(type ?? event) === "settled"`, but the daemon message is `{type:"status", state:"settled"}` (desktop-bridge.ts, daemon `report`). `handleDaemonMessage` always returns null, so **"Local run finished" never shows**. No test covers run-notify, approvals-poller or updater | Check `message.state === "settled"` (or drop the check, since the controller only calls `onSettled` for settled). Add one test that feeds a real `DaemonStatusMessage` |
| F2 | HIGH | main.ts:319 + electron-builder.yml:8-14 | When packaged, the tray icon path is `process.resourcesPath/assets/trayTemplate.png`, but `assets/**` is packed **inside app.asar** (I confirmed `Resources/assets` is absent). `trayIconPath()` returns null and the **shipped app has no tray**: no status, Connect/Disconnect, toggles, logs or Quit item | Use `path.join(__dirname, "..", "assets", …)` in both modes (Electron's fs reads asar paths), or add `assets` to `extraResources` |
| F3 | MED | apps/desktop/package.json (`electron-updater` in devDependencies) + main.ts:285 | electron-builder packs only production deps, and the asar has no `electron-updater`. Every update check rejects. The rejection is logged, so the app doesn't crash, but **the updater is dead** in every build | Move `electron-updater` to `dependencies` |
| F4 | HIGH | .github/workflows/desktop.yml:30,54 | Both jobs run `electron-builder` without `pnpm --filter @shiba/desktop build`. `dist/` is gitignored, so CI packages an app with **no main.js**. The PR artifact and any tagged draft release would be non-launchable | Run `pnpm --filter @shiba/desktop dist` (its script builds first), or add a build step |
| F5 | MED | controller.ts:92-93 → pairing.ts:149-150, main.ts:267-269 | The `conflict` and `crashed` states drop `machineId`, yet the tray offers "Disconnect" there (tray.ts:27). Unpair then **skips the server revoke** and still deletes config.json, so the adapter token stays valid until the 7-day prune. In `conflict` it also deletes the config of the running CLI daemon | Fall back to `readLocalConfig()?.machineId` for the revoke. Don't offer Disconnect in `conflict` |
| F6 | LOW | main.ts:270-277 | Tray Disconnect ignores a non-OK revoke response and deletes the local config anyway. The renderer path at pairing.ts:156 does check it | Mirror pairing.ts: stop and log when `!res.ok` |
| F7 | LOW | controller.ts:165-167 + daemon `revoked()` (no config delete) | After exit 78 (revoked) or 75 (conflict), any later probe (powerMonitor resume, set-url) sees a matching config with no child and **restarts** the daemon. §3.4 says no restart. The loop is bounded (one per probe) but noisy | In probe, skip `start([])` while state is `revoked` or `conflict` |
| F8 | LOW | controller.ts:78-79 | §3.4 says `offline` after **2 consecutive** failed heartbeats. Code flips on the first | Add a consecutive-failure counter |
| F9 | LOW | pairing.ts:85-106 | `waitForPair` has no timeout. A daemon that hangs mid-pair leaves the renderer's "Connecting…" spinning forever | Race against roughly 30s and kill the child |
| F10 | LOW | desktop-bridge.ts `unpair(): Promise<void>` vs pairing.ts:146 returns `PairResult` | Contract drift hides revoke failures from the renderer | Make `unpair` return `Promise<PairResult>` |
| F11 | LOW | release/ artifact | The .dmg/.app predate the final main.ts and pairing wiring (11:10 vs 12:32). No e2e has run against either dist or the .app | Rebuild after the fixes, then run `test:e2e` and launch the .app once |
| F12 | LOW | remote-access.md | T61 asks the T66 docs to document the manual `/api/local/*` Access bypass for wrangler and external-Access deploys. It's missing | Add one paragraph |
| F13 | INFO | approvals-poller.ts:148 | `start()` after a suspend/resume re-seeds silently, so approvals queued during sleep never notify | Keep `seen` across stop/start and skip re-seeding |
| F14 | INFO | daemon gracefulStop vs main loop | Two result POSTs race after the harness is killed. The single-use claimToken makes this harmless (as REVIEW2 N3 says) | none |

## How REVIEW2 compares

REVIEW2's D1–D8 PASS holds, and I agree with it on security. It missed F1, F2, F3 and F4 because it reviewed security invariants statically and never checked runtime wiring against the packaged artifact or the CI pipeline. Its own updater note ("PASS") is wrong at runtime (F3).

## Verdict

**BLOCKED.** No security invariant is broken (D1–D8 hold, and D8 is verified in the binary). But the shipped artifact is functionally broken in four places that §5 requires:
- no tray in the packaged app (F2)
- run-finished notifications never fire (F1)
- the updater isn't bundled (F3)
- CI packages an app with no `dist/` (F4)

Each fix is one or two lines. After fixing F1–F4 (and ideally F5), rebuild, run `pnpm --filter @shiba/desktop test:e2e`, launch the rebuilt .app once to see the tray, then re-grade as **SHIP-LOCAL-PROTOTYPE**. §7 real-deployment acceptance stays open by design.
