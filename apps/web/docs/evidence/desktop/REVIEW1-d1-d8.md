# REVIEW1 — D1–D8 static security review (pre-wiring pass)

Reviewer: worker-4 · task 10 · read-only, no code changed.
Scope: apps/desktop/src/* + scripts/shiba-local-daemon.mjs diff.
State note: main.ts:224 still awaits leader wiring of supervisor/tray/poller/updater and registerDesktopIpc — daemon IPC channels exist in pairing.ts but are not yet registered in main.ts. Re-verify handler registration in the final pass.

## Verdict table

| Inv | Verdict | Evidence |
| --- | --- | --- |
| D1 approval gate unchanged | PASS | No `POST /api/approvals` anywhere in apps/desktop (grep). Poller is GET-only (approvals-poller.ts:111); clicks load `?tab=approvals` (:124) / `?tab=activity` (run-notify.ts:11,53). Only POST in the app is `/api/computers/revoke` (pairing.ts:160-165) — a fleet revoke, not an approval action. |
| D2 no inbound listener | PASS | `createServer`/`.listen(`/`net.`/`http.create` grep clean across apps/desktop/src and the daemon diff. |
| D3 pairing targets configured origin | PASS | `desktop:pair` builds argv itself: `forkDaemon(["--connect", origin, "--pair", token])` (pairing.ts:151) with `origin` from `deps.getConfiguredOrigin()` — renderer supplies only the token (regex-validated :69,137-143). utilityProcess.fork argv form — no shell, no arg injection. |
| D4 bridge + sender checks | PARTIAL→PASS | preload exposes `shibaDesktop` only when `location.origin === --shiba-origin=…` (preload.ts:4-8); `shibaSetup` only on file: setup.html (:21-25). Handler checks: `desktop:set-url` isSetupSender (main.ts:188); `handleTrusted` wrapper checks isTrustedSender (main.ts:179-184); pairing.ts handlers check trusted() at :130, :136, :157 and file:// gate at :175-178. See findings F1/F2 — re-check after wiring. |
| D5 renderer gets no Node | PASS | webPreferences sandbox:true, contextIsolation:true, nodeIntegration:false, webviewTag:false (main.ts:116-124); `will-attach-webview` prevented (:89). |
| D6 navigation allowlist | PASS | decideNavigation: configured origin allow; non-https deny; *.cloudflareaccess.com + authHosts allow; other https → external open; will-navigate AND will-redirect both wired (main.ts:87-88); setWindowOpenHandler deny + https→external (:90-93). authHost match is exact-host + path-prefix (navigation.ts:30-37). |
| D7 no secret leaves home | PASS | adapterToken never read: shell-env drops SHIBA_WORKER_URL/LOCAL_ADAPTER_TOKEN/NODE_OPTIONS/ELECTRON_* (shell-env.ts:7,24-30); pairing token reaches only daemon argv (pairing.ts:151), never a URL/notification; notifications carry fixed title + owner/repo slug (approvals-poller.ts:41-54, run-notify.ts:31-38); email-kind approvals get a fixed label, never the address (:44-48). Daemon report() payloads contain no token (claimed/settled carry runId/harness/repoUrl/status only). |
| D8 hardening + permission handler | PASS | electron-builder.yml electronFuses = exactly the 7 required values (:15-22); hardenedRuntime:true, notarize:true (:29,32). Permission request+check handlers allow only clipboard-sanitized-write when isTrustedSender(url, configuredOrigin()) (main.ts:199-206); applied to the shared defaultSession so it survives window recreation. |

## Findings

### F1 — MEDIUM — duplicate `desktop:set-url` handler; second registration throws
- `apps/desktop/src/main.ts:187-197` registers `desktop:set-url` in `registerSetupIpc()`; `apps/desktop/src/pairing.ts:174-184` registers the same channel in `registerDesktopIpc()`. Electron's `ipcMain.handle` throws "second handler" when the leader wires pairing.ts.
- Fix: keep exactly one — prefer dropping `registerSetupIpc` and letting pairing.ts own it, or remove the channel from registerDesktopIpc.

### F2 — LOW — pairing.ts set-url sender check weaker than isSetupSender
- pairing.ts:176 accepts any frame whose URL `startsWith("file://")` + `endsWith("/setup.html")`; main.ts:60-64's isSetupSender compares the exact bundled path. Any file path ending in /setup.html would pass the pairing.ts check.
- Fix: reuse isSetupSender (pass SETUP_URL via deps) instead of the suffix check.

### F3 — LOW — validDeploymentUrl ignores packaged state
- pairing.ts:72-83 allows `http://localhost` unconditionally; navigation.ts parseDeploymentUrl allows http loopback only when `!isPackaged`. A packaged app could be pointed at plaintext http via set-url.
- Fix: thread isPackaged into the pairing.ts check or reuse parseDeploymentUrl.

### F4 — INFO — pairing-token exposure depends on daemon stderr hygiene
- waitForPair forwards the last daemon stderr line to the renderer as the error (pairing.ts:104-115). Safe today: the daemon never echoes argv/token. If a future daemon change logs the command line, the token leaks to the renderer.
- Note: keep "never log argv" as a daemon invariant.

### F5 — INFO — *.cloudflareaccess.com is any-tenant
- navigation.ts:48 allows any subdomain of cloudflareaccess.com — matches the plan spec, but a foreign Access tenant's pages can navigate in-window. Accepted per D6 spec; record only.

### F6 — INFO — graceful-stop vs loop double result post
- Daemon: a SIGTERM between execute() finishing and the main-loop result post yields two result posts (gracefulStop's errorResult + the loop's). The DO's single-use claimToken rejects the second — harmless, but worth a comment in the final pass.

## Daemon-diff checklist (worker-4's own T61 diff, re-reviewed fresh)
- report() payloads: no token/adapterToken — PASS.
- Lock: wx exclusive create; EEXIST→read pid→holderAlive(async)→alive=fail(75), dead=rm+retry once→fail(75) on second failure. No TOCTOU hole: the loser of a rm/recreate race sees a live pid or exits 75 on the stale-lock path. PASS.
- Graceful stop: kills only the direct harness child; posts errorResult("daemon stopped") + held claimToken under a 3s Promise.race; releases the lease; exits 143/130. claimToken is sent, never swallowed. PASS.
- `--help` exits in parseArgs before acquireLock — no lock created. PASS.

## Re-check list for the final pass
- main.ts wiring of registerDesktopIpc / handleTrusted channels (line 224 placeholder) — confirm each registered channel's sender check and the F1 duplicate resolution.
- Supervisor env passed to forkDaemon actually flows through shell-env.sanitize.
- Tray/poller/updater notification bodies still title+slug only once wired.
