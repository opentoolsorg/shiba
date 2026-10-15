# T63 — One-click pairing (worker-5, task 7)

## Files changed
- apps/desktop/src/pairing.ts (new) — registerDesktopIpc(deps) DI surface:
  ipcMain.handle for desktop:status / desktop:pair / desktop:unpair /
  desktop:set-url, plus emitStatusChanged() for the desktop:status-changed
  push channel. Exports channel-name constants for main.ts/preload.ts wiring.
- apps/desktop/test/pairing.test.ts (new) — 12 vitest cases.
- apps/frontend/src/desktop.d.ts (new) — Window.shibaDesktop?: ShibaDesktopBridge
  (imports the real @shiba/shared type; desktop-bridge.ts had already landed).
- apps/frontend/src/desktop-status.ts (new) — useDesktopStatus() hook:
  bridge ref, status state, refresh().
- apps/frontend/src/components/RemoteAccessView.tsx (USER-EDITED, additive) —
  header gains "Connect this computer" (primary, desktop only, hidden on
  disabled/signed-out); existing modal relabelled "Add another computer" when
  the bridge exists; fleet rows matching status().machineId get a
  "This computer" badge; pairing-token 404 now maps to the disabled state.
- apps/frontend/src/components/TaskComposer.tsx (USER-EDITED, additive) —
  optional runTarget/onRunTargetChange/localRunAvailable props; "Run on"
  select (Sandbox | This computer); LOCAL_HARNESS_OPTIONS limited to
  claude-code/codex/opencode when the local lane is selected.
- apps/frontend/src/app.tsx (shared file — minimal additive edits, flagged per
  ground rule 4): runTarget state + reset-on-unavailable effect, local branch
  in submitTask POSTing /api/runs?session=<id> with
  {repoUrl, task, baseBranch, harness?, runtime:"local", publishPullRequest},
  passing the new composer props.

## D-invariants enforced
- D3: desktop:pair builds argv ["--connect", getConfiguredOrigin(), "--pair",
  token]; the renderer never supplies a URL (pairing.ts:139-142).
- D4: every handler re-checks event.senderFrame.url via injected
  isTrustedSender; desktop:status throws, pair/unpair return {ok:false}
  (pairing.ts:113-115, 118-121, 146-149).
- D7: token never enters replies/logs — pair resolves {ok:true} on the first
  "polling" message; on earlier exit, error = last stderr line verbatim
  (daemon already formats the 401/expired message) (pairing.ts:92-109).
- Pairing-fork rule (§11.3): no restart — waitForPair resolves once, on
  "polling" or exit (pairing.test.ts covers both paths).
- desktop:set-url: accepted only from a file://…/setup.html frame; URL must be
  https: or http://localhost|127.0.0.1 (pairing.ts:166-179).
- unpair order per spec: POST <origin>/api/computers/revoke {machineId} via
  injected sessionFetch → supervisor.stop() → rm <runRoot>/config.json.
  Revoke failure aborts before the stop/delete (pairing.ts:146-163).

## DI surface for leader wave-2 wiring
DesktopIpcDeps: ipcMain, isTrustedSender (from navigation.ts), supervisor
{status(), stop(), forkDaemon(args) → child with on("message")/once("exit")/
stderr/kill}, getConfiguredOrigin, sessionFetch (session.defaultSession.fetch),
runRoot, confirmPairElsewhere(pairedTo) → Promise<boolean> (native confirm),
optional onSetUrl. DesktopStatus/PairResult mirrored structurally — identical
to packages/shared/src/desktop-bridge.ts so worker-3's supervisor stays
type-compatible without an apps/desktop package.json dependency.

## Verification
- pnpm --filter @shiba/desktop typecheck → PASS (tsc --noEmit, clean)
- cd apps/desktop && pnpm vitest run test/pairing.test.ts → PASS 12/12
- pnpm --filter @shiba/frontend typecheck → PASS (tsc --noEmit, clean)
- pnpm --filter @shiba/frontend lint → PASS (0 errors; 1 pre-existing warning
  in generated routeTree.gen.ts, untouched)

## Notes / unverified
- preload.ts bridge methods (worker-2) and supervisor.ts (worker-3) land in
  parallel; leader wires registerDesktopIpc into main.ts.
- The local run path still flows through app.tsx's existing repo/task
  validation; it posts to /api/runs with ?session=<id> when the sessions API
  is available, matching the DELETE pattern at app.tsx:839.
- "This computer · idle with harness pills" end-to-end needs the running
  shell (T60) + supervisor (T62) — covered by T66 smoke.e2e, not unit-tested
  here.
