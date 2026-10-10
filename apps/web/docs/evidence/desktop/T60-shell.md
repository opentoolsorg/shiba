# T60 — desktop shell scaffold (worker-2)

## Files
- New: apps/desktop/{package.json,tsconfig.json,vitest.config.mts,vitest.e2e.config.mts}, src/{navigation.ts,preload.ts,main.ts,setup.html,setup.js}, test/navigation.test.ts
- Shared (additive only): pnpm-workspace.yaml (electron in onlyBuiltDependencies), knip.json (apps/desktop entry), biome.json (!**/release), .gitignore (release/), apps/backend/.dev.vars.example (commented SHIBA_LOCAL_RUNTIME/LOCAL_ADAPTER_TOKEN/PAIRING_SECRET)
- `pnpm install` run once (lockfile updated). Added dep `@shiba/shared: workspace:*` because tray.ts (worker 3/6) imports it.

## Checks
- `pnpm --filter @shiba/desktop typecheck` — clean (after adding @shiba/shared dep)
- `pnpm test` — 5 files, 69 tests pass; navigation.test.ts 52 pass
- `pnpm build` — emits dist/*.js, setup.html, setup.js

## Invariants
- D4: preload.ts:7 origin from `--shiba-origin=` argv, exposes only if location.origin matches; navigation.ts isTrustedSender; main.ts handleTrusted wrapper
- D5: main.ts webPreferences sandbox/contextIsolation/nodeIntegration:false/webviewTag:false; will-attach-webview prevented
- D6: navigation.ts decideNavigation wired to will-navigate + will-redirect; setWindowOpenHandler always denies (https -> openExternal)
- D8 (permission part): only clipboard-sanitized-write for configured origin (request + check handlers)
- D2/D1: no createServer/listen, no /api/approvals call in main.ts (grep clean; approvals-poller.ts only has a doc comment)

## Unverified / notes
- Not launched under Electron (no GUI run); e2e smoke owned by another worker.
- `desktop:status|pair|unpair` NOT registered: supervisor wave must use exported `handleTrusted`. the marked comment in the `whenReady` block of main.ts is the hook point for supervisor/tray/poller/updater.
- Changing URL recreates the window (preload origin is fixed at creation).
- `pnpm lint` shows 2 no-require-imports errors in supervisor.ts and tray.ts (not my files); my files lint clean.
- `biome lint` aborted ("terminated abnormally, possibly OOM") on this machine; not run on my files.
