# T65 — build + e2e smoke + fuses evidence

Date: 2026-10-08. No source changes made (no bugs found); no git mutation.

## Build
`cd apps/desktop && pnpm build` → tsc clean; dist/ = approvals-poller, controller, logs, main, navigation, pairing, preload, run-notify, setup.{html,js}, shell-env, supervisor, tray, updater (.js).

## E2E smoke (`pnpm test:e2e`, playwright-core `_electron`, test/smoke.e2e.ts)
Stub http server on 127.0.0.1 stands in for /app/ (built into the test; no env needed). Assertions unchanged.
```
 RUN  v5.0.1 .../apps/desktop
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  3.58s
```
Covers: setup page renders (input#url visible) with no URL; /app/ loads after URL; window.shibaDesktop present; typeof require undefined; navigating to example.com leaves hostname != example.com (D6).

## Fuses (`npx @electron/fuses read --app release/mac-arm64/Shiba.app`)
```
RunAsNode is Disabled
EnableCookieEncryption is Enabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
LoadBrowserProcessSpecificV8Snapshot is Disabled
GrantFileProtocolExtraPrivileges is Disabled
WasmTrapHandlers is Enabled
```
Note: `@electron/fuses` is not a local dep; `npx --yes @electron/fuses@latest` fetched it (no `electron-fuses` bin on PATH when using plain npx).

## Artifacts in apps/desktop/release (pre-existing, not rebuilt this run)
Shiba-0.1.0-arm64.dmg 123.7M, Shiba-0.1.0-arm64-mac.zip 119.9M, Shiba-0.1.0.dmg 127.3M, Shiba-0.1.0-mac.zip 11.0M (+ .blockmap files), mac-arm64/Shiba.app, mac/.

## Unverified
- Fuses read on arm64 .app only; app signature/notarization not checked (unsigned per rules).
- Artifacts not rebuilt here; fuses reflect the existing bundle.
