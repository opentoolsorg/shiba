# T61 — backend auth fix + Access bypass + daemon hardening + daemon.test.ts

Worker: worker-4 · task 6 · team build-shiba-desktop-t-0816a73b

## Files changed
- `apps/backend/src/computers-routes.ts` — `isAuthenticated` → `await isAuthorizedRequest(request, env)` (import + gate at ~:70); minimal additive diff on the USER-edited file, matches approvals-routes.ts:32.
- `alchemy.run.ts` — added `"/api/local/*"` to `ACCESS_BYPASS_PATHS` (same self-authenticating class as /mcp; request-auth.ts:76 already exempts it).
- `scripts/check-alchemy-drift.mjs` check (e) — added `hasLocalRuntimeRule` (`/isLocalRuntimePath\s*\(/`) and a continue for `/api/local` + `/api/local/*` so the bypass entry is not flagged.
- `apps/backend/test/local-fleet.test.ts` — new `describe("auth gate")`: better-auth sign-up (node:sqlite D1 stand-in) → `GET /api/computers` 200 with session cookie, 401 anonymous; `call` helper gained an optional `cookie` field.
- `scripts/shiba-local-daemon.mjs` — additive hardening:
  - `report` hook via `process.parentPort?.postMessage({type:"status",...})` — called at polling start, claim, result settle (posted:true/false), and every heartbeat.
  - Corrected the reapDeadWorkspaces comment: nothing re-queues a claimed run; the record stays claimed until the adapter deadline.
  - `<runRoot>/daemon.lock` {pid,at}: `fs.open(…,"wx")`, acquired right after `parseArgs` (so `--help` skips it) and before pairing/loop; EEXIST → live pid → `fail(…,75)`, dead pid → unlink + one retry; released by sync `unlinkSync` in `process.on("exit")`.
  - Graceful stop: SIGTERM/SIGINT → kill active harness child (`runProcess` gained `onChild`) → best-effort POST /api/local/result with `errorResult("daemon stopped")` + held claimToken inside a 3s `Promise.race` budget → release run lease → exit 143/130. Re-entrant signals guarded; detached:true unchanged.
- `apps/desktop/test/daemon.test.ts` (new) — spawns the real script with temp `SHIBA_LOCAL_RUN_ROOT` and `SHIBA_WORKER_URL=http://127.0.0.1:9`: second instance exits 75, lock removed after SIGTERM (exit 143), `--help` exits 0 with no lock.

## Checks run
- `node --check scripts/shiba-local-daemon.mjs` → SYNTAX-OK
- `node scripts/check-alchemy-drift.mjs` → `alchemy.run.ts in sync with wrangler.jsonc (25 declared, 24 env entries)`
- `cd apps/backend && npx vitest run test/local-fleet.test.ts test/local-runtime.test.ts` → 2 files, 38 tests passed
- `cd apps/desktop && npx vitest run test/daemon.test.ts` → 1 file, 2 tests passed (~4.8s)
- `tsc --noEmit` in apps/desktop and apps/backend → clean

## D-invariants / notes
- No new endpoints, no approval-gate change, daemon still dependency-free; CLI unchanged except exit 75 and the graceful stop.
- Graceful stop kills only the direct harness child (no detached:true) — per plan ceiling.
- USER-edited files (computers-routes.ts, alchemy.run.ts) got minimal additive diffs only; nothing staged/committed per GROUND-RULES.

## Unverified
- Real-Access deploy behavior of `/api/local/*` bypass (needs a live Access-fronted stage).
