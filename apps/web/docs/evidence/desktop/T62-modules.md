# T62 modules — worker-3

## Files
- packages/shared/src/desktop-bridge.ts (new, types only, §3.5 verbatim); packages/shared/src/index.ts (+1 append-only export line)
- apps/desktop/src/shell-env.ts, supervisor.ts, logs.ts, tray.ts
- apps/desktop/test/shell-env.test.ts, supervisor.test.ts, logs.test.ts, tray.test.ts

## Checks
`vitest run --root . <4 files>` (vitest from apps/backend/node_modules; desktop has no node_modules yet): 4 files, 17 tests passed.
Not run: `pnpm --filter @shiba/desktop typecheck/lint` (no install in desktop), biome.

## Invariants
- shell-env.ts sanitize(): drops SHIBA_WORKER_URL, LOCAL_ADAPTER_TOKEN, NODE_OPTIONS, ELECTRON_* (D7/§8).
- supervisor.ts createRestartPolicy: 78 revoked, 75 conflict, 130/143 stopped, pairing-before-polling failed-pairing, 5 exits/10min crashed, backoff 1s..60s, reset after 10min healthy.
- electron imported only via lazy require() in forkDaemon and createTray (+ `import type` in supervisor.ts); everything else loads under plain Node. No http.createServer/listen.

## Notes / unverified
- tray.ts has `import type { ... } from "@shiba/shared"`: apps/desktop/package.json needs `"@shiba/shared": "workspace:*"` (worker-2 owns it). Type-only, so vitest unaffected; tsc unverified.
- package.json uses `^` on @types/node/eslint (rule 9 says exact pins) — worker-2's file.
- QUIT_WAIT_MS=5000, shouldConfirmQuit(state), PowerCallbacks exported from supervisor.ts; main.ts wires confirm dialog, SIGTERM, powerMonitor.
- Credential spike not done (needs real machine).
