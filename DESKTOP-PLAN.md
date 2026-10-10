# Shiba Desktop: detailed plan

**Revision:** 2026-10-08 (detailed, rev 2). Status: proposal. Once accepted it
goes into `PLAN.md` as §21 / Phase P11 with tasks **T59–T66** and rows in the
§2.0 table. `DESKTOP-BUILD-PROMPT.md` is the agent prompt that builds it.

**Platform:** macOS only (arm64 + x64) for v1.
**Backend integration:** every desktop↔Worker flow is in §11.
**Builds on:** T51 local runtime, T52–T55 Remote Access & Daemon Fleet.
**Standing constraints:** `spec/GOAL.md`, `ARCHITECTURE.md` §5 (security
model), the P9 prohibitions in `PLAN.md` §19.5.

**Framework decision (2026-10-08):** Electron. The alternatives considered:
- Tauri 2 needs Rust plus a Node sidecar for the daemon, and renders with
  WebKit on macOS and Linux.
- GPUI and gpuix can't render the existing DOM dashboard, so they would mean a
  full UI rewrite. gpuix is also pre-1.0 with one maintainer.

Electron runs the daemon unchanged through `utilityProcess` and keeps the whole
repo in TypeScript. t3code ships its desktop app the same way.

---

## 1. What it is

Shiba Desktop is a thin Electron shell made of three parts:

1. **A dashboard window.** It loads `https://<your-worker>/app/`, the operator's
   own deployment. The UI, auth lanes and version are the same as in the
   browser. The app ships no copy of the SPA.
2. **The local daemon.** `scripts/shiba-local-daemon.mjs` runs as a supervised
   background process, so approved `runtime:"local"` runs execute on this
   machine with the operator's own `claude` / `codex` / `opencode` CLIs.
   Caveat (existing T51 behavior): each run gets a fresh `HOME`
   (`shiba-local-daemon.mjs:300`). Env-var API keys reach the harness, and so
   does Keychain-backed auth. File-based logins under the real `~` (such as
   `~/.codex/auth.json`) don't. T62 checks this with real logins (§8).
   Second caveat: `/claim` hands the oldest pending run to whichever paired
   daemon asks first, with no machine filter (`local-dispatch.ts:129-132`).
   "Runs on this machine" holds only when one computer is paired (§9).
3. **Native glue.** A "Connect this computer" button replaces the copy-paste
   command, plus a tray status, approval and run notifications, and start at
   login.

The backend gets no new endpoints, the approval gate doesn't change, and the
operator's machine opens no ports.

---

## 2. Decisions (locked unless a task's spike disproves them)

| # | Decision | Detail |
|---|---|---|
| A1 | Electron `44.7.0`, `electron-builder` `26.15.3`, `electron-updater` `6.8.9` | Pin the Electron toolchain to exact versions. It's a security-sensitive runtime, though the repo has no repo-wide exact-pin rule. Re-check with `npm view` when T60 starts. |
| A2 | Remote-loaded UI | The window loads `<origin>/app/`. Cookies (Cloudflare Access `CF_Authorization`, better-auth session) behave exactly as in a browser. |
| A3 | Daemon via `utilityProcess.fork` | The script stays dependency-free and runnable standalone. The app adds only two additive hooks (T61). |
| A4 | Pairing mode only | The app always runs the daemon from `~/.shiba-local/config.json`. It strips `SHIBA_WORKER_URL` / `LOCAL_ADAPTER_TOKEN` from the daemon env so a stray shell export can't override pairing. The daemon uses `??`, so even an exported empty value would win (`shiba-local-daemon.mjs:495-498`). Env-var mode stays a CLI-only feature. |
| A5 | Main process owns notifications | Main polls `GET /api/approvals` with `session.defaultSession.fetch(..., { credentials: "include" })`. Electron blocks cookies on `fetch` unless credentials are set explicitly. No frontend change is needed for notifications. |
| A6 | CommonJS build output | Sandboxed preloads must be CommonJS. Main uses the same format, so there's one `tsc` config and no bundler. |
| A7 | **macOS only** (arm64 + x64) | Decided 2026-10-08. Linux and Windows are out of scope for v1 (§9). There's one CI runner, one signing pipeline, and one tray and login-item model to support. |
| A8 | Distribution: GitHub Releases (draft) + `electron-updater` | Humans publish releases. The agent never tags or publishes (`spec/GOAL.md`: "No external deployment. No push."). |
| A9 | App id `dev.shiba.desktop`, product name `Shiba` | Change before the first signed build if the org wants a different bundle id (§10). |

---

## 3. Architecture

### 3.1 Shape

```
┌──────────────────────────── Shiba Desktop (Electron) ────────────────────────────┐
│ main process (src/main.ts)                                                       │
│  ├─ BrowserWindow ── loads <origin>/app/   sandbox, contextIsolation, no Node    │
│  │     └─ preload.ts → window.shibaDesktop {version,status,pair,unpair,onStatus} │
│  │                     (exposed only when location.origin === configured origin) │
│  ├─ setup.html ── first-run "Your Shiba URL" (only bundled page)                 │
│  ├─ Tray + app menu ── status, Open, Approvals, Connect/Disconnect, toggles      │
│  ├─ approvals poller ── session.fetch /api/approvals every 30s → Notification    │
│  └─ supervisor ── utilityProcess.fork(shiba-local-daemon.mjs)                    │
│          ├─ env = login-shell env − {SHIBA_WORKER_URL, LOCAL_ADAPTER_TOKEN, …}   │
│          ├─ parentPort status messages → state machine (§3.4)                    │
│          └─ spawns claude / codex / opencode with the operator's own logins      │
└───────────────┬───────────────────────────────────────────┬──────────────────────┘
   HTTPS + session cookie (Access | better-auth)            │ HTTPS outbound poll, adapter bearer
                ▼                                           ▼
   /app/*, /api/approvals, /api/computers/*      /api/local/{pair,claim,result,heartbeat}
                └──────────── Worker: CodingOrchestrator · LocalDispatch DO ───────────┘
```

### 3.2 Package layout

```
apps/desktop/
  package.json            @shiba/desktop, "type": "commonjs", main: dist/main.js
                          scripts: build (tsc), start (build + electron .), typecheck,
                          lint (eslint src), test (vitest run), dist (electron-builder)
  tsconfig.json           standalone (don't extend root: it sets composite +
                          emitDeclarationOnly + include alchemy.run.ts, so no JS
                          would emit); module/moduleResolution NodeNext, outDir dist
  electron-builder.yml    targets, fuses, extraResources (daemon), publish (draft)
  assets/                 icon.icns, icon.png, trayTemplate.png (+@2x) from the mascot svg
  src/
    main.ts               lifecycle, window, menu, tray, IPC, approvals poller, updater
    preload.ts            contextBridge surface (§3.5), origin-gated
    navigation.ts         PURE: deployment URL parsing + navigation/sender decisions
    supervisor.ts         PURE policy (exit code → action, backoff, crash budget)
                          + thin utilityProcess wrapper (only file importing electron for it)
    shell-env.ts          PURE parse/sanitize of login-shell env + capture helper
    setup.html, setup.js  first-run form (strict CSP, no inline script)
  test/
    navigation.test.ts, supervisor.test.ts, shell-env.test.ts
    daemon.test.ts        spawns the real daemon script (lock, exit 75, --help)
    smoke.e2e.ts          playwright-core `_electron` (local/macOS, not in `pnpm test`)
packages/shared/src/desktop-bridge.ts   pure types: DesktopStatus, ShibaDesktopBridge,
                                        DaemonStatusMessage (no runtime code, no zod)
apps/frontend/src/desktop.d.ts          `interface Window { shibaDesktop?: ShibaDesktopBridge }`
```

Rule: the `navigation`, `supervisor` policy and `shell-env` modules never
import `electron`, so vitest runs them under plain Node.

### 3.3 Files on disk

| Path | Owner | Contents |
|---|---|---|
| `<userData>/config.json` | app | `{ deploymentUrl, notifications: true, startAtLogin: true, authHosts?: string[] }`. Written by plain `fs`; no electron-store. |
| `<userData>/logs/main.log`, `daemon.log` | app | Append. Rotates at 5 MB, keeping one `.1`. |
| `~/.shiba-local/config.json` (0600) | daemon | `{ workerUrl, adapterToken, machineId }`. Unchanged. The app reads only `workerUrl` and `machineId` and never sends `adapterToken` anywhere. |
| `~/.shiba-local/machine-id` | daemon | Unchanged. |
| `~/.shiba-local/daemon.lock` | daemon (new, T61) | `{ pid, at }`. One daemon per machine, app or CLI. |

`SHIBA_LOCAL_RUN_ROOT` is honored if set, as the daemon already does. The app
resolves the run root from the *captured login-shell env*, not a hard-coded
`~/.shiba-local`, so the app and the daemon read the same `config.json`.

### 3.4 Daemon state machine (main process)

Probe first: `GET <origin>/api/computers` via session fetch, `redirect: "manual"`.

| State | Entered when | Tray label | Supervisor action |
|---|---|---|---|
| `signed-out` | probe returns 401, a 3xx, or a network error | "Sign in to Shiba" | Re-probe on window `did-navigate` to the origin, and every 60s |
| `disabled` | probe returns 404 (local runtime off; `computers-routes.ts` returns 404) | "Local runs disabled on this Shiba" | Stop the daemon if it's running. If the flag is turned off after pairing, `/api/local/*` returns 404 and the daemon retries forever (§11.9). |
| `unpaired` | probe 200, and no `~/.shiba-local/config.json` | "Not connected" + "Connect this computer…" | none |
| `paired-elsewhere` | config `workerUrl` ≠ configured origin | "Paired to another Shiba" | none. Re-pairing asks for confirmation first. |
| `starting` | fork issued | "Starting…" | |
| `idle` | daemon message `polling`, or `settled` | "Connected · idle" | |
| `busy` | daemon message `claimed` | "Running · <owner/repo>" | |
| `offline` | 2 consecutive `heartbeat {ok:false}` | "Offline · retrying" | none (the daemon retries itself) |
| `revoked` | exit `78` | "Revoked · reconnect" | **no restart** |
| `conflict` | exit `75` (lock held) | "Another daemon is running" | **no restart**. Shows the pid from stderr. |
| `crashed` | 5 abnormal exits within 10 min | "Daemon crashed · View logs" | stop |
| (restart) | any other exit code | unchanged | backoff 1s, 2s, 4s … capped at 60s. The counter resets after 10 min healthy. |

Exits `130` and `143` (signals the app sent) never trigger a restart.

**Pairing forks are special.** A fork started with `--connect/--pair` that exits
before its first `polling` message is a failed pairing. It doesn't restart, the
state goes back to `unpaired`, and the stderr line becomes the error. The daemon
exits 1 for a bad token and for a crash alike (`shiba-local-daemon.mjs:54,470`),
and pairing tokens are single-use. Restarts never re-pass `--pair`, because
once paired the daemon runs from `config.json`.

**The probe gates only the daemon.** The approvals poller (T64) has its own
gate: it starts when `GET /api/approvals` returns 200. Local runtime is off by
default (`SHIBA_LOCAL_RUNTIME` unset), and approval notifications still have to
work then.

**The probe depends on a T61 fix.** `/api/computers` currently checks the
synchronous `isAuthenticated` (`computers-routes.ts:69`). That check returns
false for the better-auth lane (`request-auth.ts:86-88`), so a signed-in
better-auth user would get 401 and the app would sit in `signed-out` forever.
T61 switches the route to `await isAuthorizedRequest`, matching
`approvals-routes.ts:32`.

### 3.5 Bridge contract (`packages/shared/src/desktop-bridge.ts`, types only)

```ts
export type DesktopDaemonState =
  | "signed-out" | "disabled" | "unpaired" | "paired-elsewhere"
  | "starting" | "idle" | "busy" | "offline" | "revoked" | "conflict" | "crashed";

export interface DesktopStatus {
  state: DesktopDaemonState;
  machineId?: string;      // not a secret; marks "This computer" in the fleet list
  activeRunId?: string;
  harnesses?: string[];
  pairedTo?: string;       // only for paired-elsewhere: the other origin
  detail?: string;         // human-readable; never contains a token
}

export type PairResult = { ok: true } | { ok: false; error: string };

export interface ShibaDesktopBridge {
  readonly version: string;
  status(): Promise<DesktopStatus>;
  pair(pairingToken: string): Promise<PairResult>;
  unpair(): Promise<void>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
}

// Daemon → main over process.parentPort (hand-mirrored in the dep-free daemon).
export type DaemonStatusMessage =
  | { type: "status"; state: "polling"; machineId: string; harnesses: string[] }
  | { type: "status"; state: "claimed"; runId: string; harness: string; repoUrl: string }
  // Sent after the result POST. `posted` = the Worker accepted it. `status` is the daemon's
  // own view; harness.verify and PR publish still run Worker-side (§11.7).
  | { type: "status"; state: "settled"; runId: string; status: string; exitCode: number; repoUrl: string; posted: boolean }
  | { type: "status"; state: "heartbeat"; ok: boolean };
```

IPC channels are `desktop:status`, `desktop:pair`, `desktop:unpair` (invoke) and
`desktop:status-changed` (push). Setup uses `desktop:set-url`, which is accepted
only from the bundled `setup.html` frame.

---

## 4. Desktop security invariants (D1–D8): acceptance criteria

| # | Invariant | Enforcement point | Proof |
|---|---|---|---|
| D1 | **The approval gate is unchanged.** Nothing outside the dashboard approval card can approve or reject. Notifications and the tray only open `/app/?tab=approvals`. | `main.ts` has no `POST /api/approvals` call | grep in review, plus a manual acceptance check |
| D2 | **No inbound listener.** The app and daemon only connect outbound. | No `http.createServer`, no `listen` | review grep |
| D3 | **Pairing targets only the configured origin.** `pair()` builds `--connect <configured origin>` itself. A URL never comes from the renderer. | `desktop:pair` handler | test: `isTrustedSender` rejects a foreign origin |
| D4 | **Only the configured origin gets the bridge.** The preload exposes `shibaDesktop` only when `location.origin` equals the origin passed via `additionalArguments`. Every IPC handler also checks `event.senderFrame.url`. | `preload.ts` + `navigation.ts#isTrustedSender` | unit test, plus the e2e check (bridge absent on a foreign page) |
| D5 | **The renderer gets no Node.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, `will-attach-webview` prevented. | `main.ts` webPreferences | e2e: `typeof require === "undefined"` |
| D6 | **Navigation is allowlisted.** The configured origin, `*.cloudflareaccess.com` and the `authHosts` hops (default `accounts.google.com`, `github.com/login`, `github.com/session`, `login.microsoftonline.com`) are allowed. Other https URLs open in the system browser. Everything else is denied. `setWindowOpenHandler` always denies and opens https URLs externally. | `navigation.ts#decideNavigation`, wired to `will-navigate` + `will-redirect` | unit table test |
| D7 | **No secret leaves its home.** The adapter token is never read into IPC replies, logs, notifications or URLs. Pairing tokens appear only in the daemon argv, as the CLI flow already does, and never in a URL. Notifications show only the title and `owner/repo`, never task text or a diff. | `desktop:pair`, approvals poller | review, plus a log grep during acceptance |
| D8 | **The binary is hardened.** Fuses: `runAsNode:false`, `enableNodeOptionsEnvironmentVariable:false`, `enableNodeCliInspectArguments:false`, `enableCookieEncryption:true`, `onlyLoadAppFromAsar:true`, `enableEmbeddedAsarIntegrityValidation:true`, `grantFileProtocolExtraPrivileges:false`. macOS builds use hardened runtime and notarization. Permission handler: allow only `clipboard-sanitized-write` for the configured origin (the dashboard's copy buttons need it), deny everything else. | `electron-builder.yml` `electronFuses`, `main.ts` | `npx @electron/fuses read --app <path>` in acceptance |

---

## 5. Tasks

### T59 · Spec, ADR, tracker rows (~2h)
- `spec/GOAL.md` product contract, new item 15: *"Optionally install Shiba
  Desktop (macOS): the same dashboard as an app, plus one-click pairing
  that runs approved local tasks on this machine. It adds no ingress surface
  and no approval path."*
- `apps/web/docs/adr/0001-desktop-shell-electron.md`. Create the folder; per
  `apps/web/docs/agents/domain.md` it's created lazily, and that file gives only
  the `NNNN-<slug>.md` naming. Use four headings: **Context**, **Options**
  (Electron, Tauri 2, GPUI, gpuix, with one line on why each lost),
  **Decision**, **Consequences** (bundle size and RAM accepted; TypeScript
  everywhere; daemon reused unchanged).
- Append `PLAN.md` §21 Phase P11 (a short pointer to this file plus D1–D8) and
  the T59 row in the §2.0 status table (the rev 11 table at `PLAN.md:56`; three
  `### 2.0` headings exist). Each later task adds its own row when its state changes,
  because the tracker treats a task with no row as open. Append only; don't
  rewrite existing sections.
- **Done when:** `pnpm docs:verify` and the gate pass.

### T60 · Desktop shell + login spike (~1d)
- Scaffold `apps/desktop` (§3.2).
  - Add `electron` to `onlyBuiltDependencies` in `pnpm-workspace.yaml`. pnpm 10
    blocks its postinstall binary download otherwise.
  - Add a knip workspace entry: `src/main.ts`, `src/preload.ts`,
    `test/**/*.test.ts`.
  - Name the launch script `start`, not `dev`. Root `pnpm dev` runs every
    `dev` task through turbo, and a desktop `dev` would pop a window each time.
- `setup.html`/`setup.js`: a URL field. `navigation.ts#parseDeploymentUrl`
  accepts `https:` only, or `http://localhost|127.0.0.1` when `!app.isPackaged`,
  and reduces it to an origin. The result is saved to `<userData>/config.json`.
  A "Change Shiba URL…" menu item reopens setup.
- Window:
  - Single-instance lock (a second launch focuses the existing window).
  - Bounds restored from config.
  - macOS: close hides the window and the app stays in the tray. Real quit
    comes from the menu or Cmd+Q.
  - `did-fail-load` on the origin goes back to setup with the error shown.
- Menu: role-based `appMenu`, `editMenu` (without it, Cmd+C/V break in inputs
  on macOS), `viewMenu` (reload, devtools), `windowMenu`.
- D4, D5, D6, D8 permission handler wired in.
- **Login spike (do first, report before T61):**
  1. Try the better-auth email+password lane in the window. It's expected to
     work.
  2. Try Cloudflare Access with the deployment's real IdP.
  3. If Google refuses the embedded browser, strip the `Electron/…` and app
     tokens from `app.userAgentFallback` and retry.
  4. If it's still blocked, the documented fallback is Access one-time PIN or
     the GitHub IdP.
  5. Record the outcome in `VERIFICATION.md`.
- Dev loop:
  1. In `apps/backend/.dev.vars`, set `SHIBA_LOCAL_RUNTIME=1` and
     `LOCAL_ADAPTER_TOKEN` (or `PAIRING_SECRET`). Without them the probe gets
     404 and the app shows `disabled`.
  2. Run the Worker on 8788 and Vite on 5173. `pnpm dev` runs a bare
     `wrangler dev --port 8788`, which does not work for this loop as-is (and
     on a Docker-less machine does not start at all); start the Worker with the
     command below instead.
     `apps/backend/wrangler.jsonc` sets `routes: app.tryshiba.dev` as a custom
     domain, so `wrangler dev` needs two extra flags. Without
     `--local-upstream localhost:8788` wrangler rewrites the request host to
     `app.tryshiba.dev`, the loopback lane isn't recognized, and every `/api/*`
     returns 401 `{code:"access_not_configured"}`. Add
     `--enable-containers=false` when no Docker daemon is running, or wrangler
     exits with "Cannot connect to the Docker daemon". That flag is enough for
     pairing, heartbeat and the fleet list only: a dispatched run still builds
     a Sandbox DO stub and fails with "Containers have not been enabled", so
     the run lifecycle needs a running Docker (first start builds the sandbox
     image, several minutes). Verified:
     `cd apps/backend && npx wrangler dev --port 8788 --enable-containers=false --local-upstream localhost:8788 --var SHIBA_LOCAL_RUNTIME:1 --var PAIRING_SECRET:<random>`.
  3. Run `SHIBA_DESKTOP_URL=http://localhost:5173 pnpm --filter @shiba/desktop start`.
     The env var skips setup in dev only.
  4. localhost skips login only when neither Access nor a ≥32-char
     `BETTER_AUTH_SECRET` is configured (`request-auth.ts:82-84`). With
     better-auth set, sign in in the window as usual.
  5. Use a **named session** for local runs. The loopback lane's default
     session lives on the DO named `"default"`, and dispatch refuses
     `runtime:"local"` there (`web-sessions.ts:197-198,290`). This is the same
     setup `local-runtime.test.ts:426` uses.
  6. Add the three keys to `apps/backend/.dev.vars.example`, commented out.
     Today it lists none of them.
- **Done when:**
  - The window loads `/app/` and you can sign in.
  - The `navigation.test.ts` table passes.
  - The gate is green.

### T61 · Daemon + backend prerequisites (~1d)
Two backend fixes and additive daemon changes. Both backend fixes repair the
existing Remote Access feature (P9), which is broken in the same way for CLI
users today. Neither adds an endpoint.

**Backend fix 1: auth gate on `/api/computers*`.** `computers-routes.ts:69`
uses the synchronous `isAuthenticated`, which returns false for the better-auth
lane (`request-auth.ts:86-88`). Signed-in better-auth users get 401 on the fleet
list, `pairing-token` and `revoke`. Change it to
`await isAuthorizedRequest(request, env)`, matching `approvals-routes.ts:32`.
Add a test in `apps/backend/test/local-fleet.test.ts`: with a better-auth
session, `GET /api/computers` returns 200.

**Backend fix 2: Access bypass for the daemon.** `ACCESS_BYPASS_PATHS` in
`alchemy.run.ts:113-125` has no `/api/local/*`, and `DashboardAccess` covers the
whole host (`:127-131`). On Access-fronted deploys the daemon gets the Access
login page. Add `"/api/local/*"`. It's the same class as `/mcp`: the Worker
self-authenticates it (bearer or HMAC pairing token), and `request-auth.ts`
already exempts it. Extend drift check (e) (`scripts/check-alchemy-drift.mjs:587-596`)
to recognize `isLocalRuntimePath`. Without that it reports "has no Worker auth
exemption". Then run `node scripts/check-alchemy-drift.mjs`. Document the
manual equivalent for wrangler deploys with an external Access app in the T66
docs.

**Daemon (`scripts/shiba-local-daemon.mjs`).** It stays dependency-free, and CLI
behavior is unchanged except for exit code 75 and the graceful stop.
- Status hook: `const report = (msg) => process.parentPort?.postMessage({ type: "status", ...msg });`.
  It's a no-op under plain `node`. Call it at:
  - polling start (`polling`, with machineId and harnesses)
  - after a claim (`claimed`)
  - after the result POST (`settled`, with `posted`)
  - in every heartbeat (`heartbeat {ok}`).
- Fix the misleading comment at `:162`. It says a claimed run re-posts via the
  DO, but nothing in `LocalDispatch` moves a claimed record back to pending.
- `<runRoot>/daemon.lock`:
  - Acquire it before pairing and before the loop, and skip it for `--help`.
  - Exclusive create (`fs.open(path, "wx")`).
  - On `EEXIST`, read the pid. If it's alive (`await holderAlive(pid)`; it's
    async), call `fail("another shiba-local daemon is running (pid N)", 75)`. If
    it's dead, unlink and retry once.
  - Release it with a **sync** `fs.unlinkSync` in a `process.on("exit")`
    handler. The script exits through `process.exit` in many places, and async
    cleanup wouldn't run.
- Graceful stop. Today SIGTERM exits 143 at once (`:552-553`): the harness child
  is orphaned (spawned non-detached, `:175`) and no result is posted. The run
  then fails only at the adapter's 25-min deadline (`runtime.ts:422,513-520`);
  the 45-min reaper is just the orphan backstop. The new handler on
  SIGTERM/SIGINT:
  1. Kill the active harness child.
  2. POST `/api/local/result` with `errorResult("daemon stopped")` and the held
     `claimToken`, within a 3s budget.
  3. Release the lease, then exit 143/130 as before.

  Ceiling: the handler kills only the direct child. A process-group kill would
  need `detached: true`, which is a behavior change, so it isn't done here.
- **Done when:**
  - New `apps/desktop/test/daemon.test.ts` (plain-Node vitest) spawns the real
    script with a temp `SHIBA_LOCAL_RUN_ROOT` and
    `SHIBA_WORKER_URL=http://127.0.0.1:9`. That's unreachable, so instance A
    keeps retrying its claim and stays alive. It proves:
    - a second instance exits 75
    - the lock is gone after A gets SIGTERM
    - `--help` exits 0 without creating a lock

    Existing backend tests never spawn the daemon, so they prove nothing about
    it.
  - The backend fix 1 test passes. `local-runtime.test.ts` and
    `local-fleet.test.ts` stay green, and `check-alchemy-drift` is clean.

### T62 · Supervisor, tray, start at login (~1.5d)
- Create `packages/shared/src/desktop-bridge.ts` (§3.5) here, the first task
  that uses it, so knip never sees unused types.
- `shell-env.ts`:
  - Run `$SHELL -ilc 'printf "\0__SHIBA_ENV__\0"; env -0'` with a 10s timeout.
    Parse only what comes after the marker, because rc files print banners.
  - On failure, fall back to `process.env` with `/opt/homebrew/bin`,
    `/usr/local/bin` and `~/.local/bin` appended to PATH.
  - `sanitize()` drops `SHIBA_WORKER_URL`, `LOCAL_ADAPTER_TOKEN`,
    `NODE_OPTIONS` and `ELECTRON_*`.
  - Keep the rest of the env. The daemon spreads `process.env` into each run
    so harness CLIs see the operator's provider keys and `{env:VAR}`
    placeholders resolve.
- `supervisor.ts`:
  - The state machine from §3.4.
  - `utilityProcess.fork(daemonPath, args, { env, stdio: "pipe", serviceName: "shiba-local-daemon" })`.
  - stdout and stderr go to `daemon.log`.
  - Daemon path: `process.resourcesPath/daemon/shiba-local-daemon.mjs` when
    packaged, else the repo's `scripts/` file.
- Tray: a status line plus Open Shiba, Approvals, Connect / Disconnect this
  computer, Notifications ✓, Start at login ✓ (macOS
  `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`), Change
  Shiba URL…, View logs (`shell.openPath`), Check for updates, Quit.
  Harness pills can include `agy`: the daemon probes it (`:50`), but it isn't
  local-runnable. Show it as listed and don't promise it.
- Quit while `busy`: show a native confirm dialog in main ("A local run is in
  progress. Quitting stops it and reports it failed"), then SIGTERM. Wait for
  the daemon's exit (its 3s budget plus a 2s margin) before `app.exit()`, so
  the result POST isn't cut off. The T61 graceful stop kills the harness and
  posts the failed result, so the run settles right away instead of waiting for
  the 25-min adapter deadline.
- **Credential spike.** Run one local `claude-code` run and one `codex` run on a
  machine that has only subscription logins (no API-key env vars). Each run's
  `HOME` is fresh (`:300`), so file-based logins may be invisible. Record the
  result in `VERIFICATION.md`. If they fail, open a T51 follow-up in `PLAN.md`
  (for example, pass `CODEX_HOME` / `CLAUDE_CONFIG_DIR` through to the real
  dirs). It's a security-relevant choice for a human, so don't fix it here.
- Sleep and wake: `powerMonitor` `suspend` pauses the approvals poller.
  `resume` re-probes.
- **Done when:** `supervisor.test.ts` passes. It covers:
  - exit 78 → revoked, no restart
  - exit 75 → conflict, no restart
  - 143 → stopped, no restart
  - 1 → restart with growing backoff
  - the crash budget → crashed

  `shell-env.test.ts` must also cover banner noise before the marker, and a
  forbidden var being stripped.

### T63 · One-click pairing (~1d)
- `preload.ts`: `contextBridge.exposeInMainWorld("shibaDesktop", …)` only if
  `location.origin === <origin from --shiba-origin=… additionalArgument>`.
- `desktop:pair` handler:
  1. Check the sender (D4).
  2. Validate the token shape: two base64url segments joined by `.`, at most
     1024 chars. That's the server schema's cap (`local-fleet-schema.ts:22`);
     real tokens are about 124.
  3. If `paired-elsewhere`, show a native confirm.
  4. Stop the daemon and fork it with `--connect <configured origin> --pair <token>`.
     It pairs, then drops into the normal loop.
  5. Resolve `{ok:true}` on the first `polling` message. If it exits first,
     resolve `{ok:false, error}` from the daemon's last stderr line (no restart;
     §3.4). On a 401 it reads "pairing token expired, reused, or invalid";
     anything else reads "pairing failed: …".
- Disconnect, from the tray or `desktop:unpair`:
  1. `POST /api/computers/revoke {machineId}` via `session.fetch` (credentials
     included).
  2. Stop the daemon.
  3. Delete `<runRoot>/config.json`.

  Skipping the revoke would leave the token hash valid until the 7-day prune
  (`local-dispatch.ts:236`, `local-fleet.ts:57`). The server mints a new
  machineId on every pair (`local-dispatch.ts:226`), so `machine-id` doesn't
  matter in pairing mode.
- `RemoteAccessView.tsx`:
  - When `window.shibaDesktop` exists, the primary header button becomes
    **Connect this computer**. It POSTs `/api/computers/pairing-token`, calls
    `shibaDesktop.pair(body.token)`, toasts the result, then reloads the fleet.
  - The existing modal stays as **Add another computer**.
  - Mark the fleet row whose `machineId` matches `status().machineId` as
    *This computer*.
  - When the bridge state is `disabled` or `signed-out`, the button stays
    hidden. The existing 404 empty state already covers the disabled case.
- **Composer run target (GAP-3, §11.5).** Today nothing in the dashboard selects
  `runtime:"local"`. `submitTask` sends chat text over the WebSocket
  (`app.tsx:788-805`), so a local run happens only if the model infers it from
  the prose.
  - Add a **Run on: Sandbox | This computer** control to `TaskComposer.tsx`.
    Show it only when the bridge state is `idle` or `busy`.
  - "This computer" submits through the existing `POST /api/runs`, with the
    body `local-runtime.test.ts:422-450` uses (`repoUrl`, `task`, `baseBranch`,
    `harness`, `runtime:"local"`, `publishPullRequest`). `handleRuns` stamps the
    intake voucher (`runs-routes.ts:92-93`), and the approval card appears in
    Approvals like any other.
  - Limit harness choices to `claude-code` / `codex` / `opencode`, the
    local-capable ones.
  - "Sandbox" keeps today's chat path unchanged.
- `apps/frontend/src/desktop.d.ts`: the global `Window` augmentation. No new
  frontend deps.
- **Done when:**
  - A fresh machine pairs with one click and shows "This computer · idle" with
    harness pills.
  - A browser (no bridge) behaves exactly as before.

### T64 · Notifications (~0.5d)
- Approvals poller in main:
  - Gate it on its own probe: start when `GET /api/approvals` returns 200. It
    doesn't depend on the daemon probe, because local runtime is off by
    default. Poll every 30s. That's slower than the dashboard's 10s, because
    `app.tsx` notes this poll drives DO writes.
  - Seed the first poll silently.
  - For each new `approvalId`, show
    `new Notification({ title: "Approval needed", body })`. `body` is
    `owner/repo` for run approvals. Email kinds carry a mailbox address in
    `repoUrl` (`WorkspacePanel.tsx:34-36`), so branch on `kind` and show only
    "Email send" or "Email delete", never the address.
  - Click: `win.show()` + `loadURL(<origin>/app/?tab=approvals)`.
  - Toggle from the tray.
- Run finished: on the daemon's `settled` message, show
  `Notification({ title: "Local run finished", body: "<owner/repo>" })`.
  Never say "completed": the Worker's `harness.verify` and PR publish run after
  the daemon settles, and either can still fail the run (§11.7). Click:
  `/app/?tab=activity`. A `?run=` link can't be built, because the daemon's
  `runId` is the sandboxId, not the run-record id.
- **Done when:** with the window hidden, a newly queued approval notifies
  within 30s, and clicking it lands on the approvals view.

### T65 · Packaging, signing, updates, CI (~2d)
- `electron-builder.yml`:
  - `appId`, `productName`, `directories.output: release`, `files: [dist/**, assets/**]`.
  - `extraResources: [{ from: ../../scripts/shiba-local-daemon.mjs, to: daemon/shiba-local-daemon.mjs }]`.
    It sits outside the asar but is sealed by the macOS code signature.
  - `electronFuses` (D8).
  - mac: `target: [dmg, zip]` for arm64 and x64, `hardenedRuntime: true`,
    notarize via env (`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or
    `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`).
  - No Linux or Windows targets in v1.
  - `publish: { provider: github, owner: princepal9120, repo: ai-intern, releaseType: draft }`.
- Updater:
  - `autoUpdater.checkForUpdatesAndNotify()` at launch and every 6h, only when
    `app.isPackaged`.
  - Errors are logged and never crash the app. Unsigned mac builds can't
    self-update.
- `.github/workflows/desktop.yml`:
  - On PRs touching `apps/desktop/**`, `scripts/shiba-local-daemon.mjs` or
    `packages/shared/src/desktop-bridge.ts`: one `macos-latest` job runs
    install → desktop typecheck/lint/test →
    `electron-builder --publish never` (unsigned:
    `CSC_IDENTITY_AUTO_DISCOVERY=false`) → upload the artifact.
  - On `desktop-v*` tags: signed and notarized → draft release.
  - Secrets are added by a human.
- `pnpm build` (root gate) runs the desktop `tsc` build. `dist` stays out of
  the gate because it's slow and needs secrets.
- Write `test/smoke.e2e.ts` here (spec in T66), because this task's Done-when
  needs it.
- Add `release` to `.gitignore` (today it only has `dist/`) and to biome's
  ignore list (`biome.json:12` has only `**/dist`). Otherwise `pnpm lint` and
  `check:ci` scan the build output.
- **Done when:**
  - An unsigned local `pnpm --filter @shiba/desktop dist` produces a launchable
    `.app` that passes the e2e smoke test.
  - `npx @electron/fuses read --app release/mac-arm64/Shiba.app` shows the D8
    values.
  - The workflow passes `actionlint` if it's available.

### T66 · Verification + docs (~1d)
- Finish `test/smoke.e2e.ts`, first written in T65. It uses `playwright-core`
  `_electron.launch` and checks:
  - the setup page renders
  - after the URL is set, `/app/` loads
  - `window.shibaDesktop` is present and `typeof require === "undefined"`
  - navigating to `https://example.com` doesn't stay in-app.

  It runs locally on macOS via `pnpm --filter @shiba/desktop test:e2e` and
  isn't part of `pnpm test`.
- Run the manual acceptance in §7 against a real deployment and record a dated
  entry in `VERIFICATION.md`. Until that entry exists, the status stays
  "local prototype".
- Docs: add a "Desktop app" section to
  `apps/web/src/content/docs/docs/remote-access.md` covering install,
  first run, Connect this computer, tray states, logs, unsigned-build Gatekeeper
  note, and uninstall (delete the app plus `~/.shiba-local`). The
  `check-docs` denylist applies.
- A separate **security review pass** checks D1–D8 on the main model, using a
  fresh reviewer that didn't write the code.

---

## 6. Order, gate, timeline

```
T59 ─► T60 (login spike = STOP + report) ─► T61 ─► T62 ─► T63 ─► T64 ─► T65 ─► T66
                                                    └── security review after T63 ──┘
```

About 9 working days for one developer.

**Gate after every task** (from `CLAUDE.md`):
`pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built`,
then `pnpm check:ci`.

**Prohibitions:**
- no new backend endpoints or ingress. Backend changes are limited to T61's
  two fixes: the `/api/computers` auth gate and the `/api/local/*` Access bypass
- no inbound listener
- no approve or reject path outside the dashboard card
- the daemon stays dependency-free and works from the CLI
- no Node in the renderer
- no secrets in IPC, URLs, logs or notifications
- no new frontend dependencies
- no zod in `packages/shared` for this surface (types only, matching the P9 rule)
- no deploy, push, tag or release by the implementing agent.

---

## 7. Manual acceptance (dated entry in `VERIFICATION.md`)

The deployment needs:
- `SHIBA_LOCAL_RUNTIME=1`
- the `LocalDispatch` binding
- at least one of `LOCAL_ADAPTER_TOKEN` / `PAIRING_SECRET`. `PAIRING_SECRET` is
  optional and falls back to `LOCAL_ADAPTER_TOKEN` (`computers-routes.ts:18-20`).

On Access-fronted deploys, `/api/local/*` must be in the Access bypass (T61
fix 2). For desktop-only fleets, prefer `PAIRING_SECRET` alone. Whoever holds
`LOCAL_ADAPTER_TOKEN` can heartbeat as any machine (`local-routes.ts:77-80`).
Pair exactly one computer for this run (the `/claim` targeting caveat, §1).

1. Install the unsigned build and open it (right-click → Open on macOS).
   Setup appears. Enter the Shiba URL and sign in. The dashboard loads.
2. Remote Access → **Connect this computer**. The row appears marked
   *This computer* · idle, with harness pills. The tray shows "Connected · idle".
3. Hide the window. From the browser dashboard, queue a task with
   **Run on: This computer** (claude-code or codex; T63 composer control). A
   notification arrives within 30s. Clicking it opens Approvals in the app.
   Approve.
4. The tray shows "Running · owner/repo". `daemon.log` shows the claim. Then
   comes a "Local run finished" notification. After the Worker's verify step,
   the diff (and PR, if requested) appears in the dashboard.
5. Revoke the row from the fleet list. Within about 30s the tray shows
   "Revoked · reconnect" and the daemon doesn't restart. Connect again and it
   works.
6. With the app daemon running, start the CLI daemon in a terminal. It exits
   75 with "another shiba-local daemon is running".
7. Quit while a run is busy. The confirmation dialog appears. After you
   confirm, the run shows failed "daemon stopped" in the dashboard within
   seconds, and no harness process is left behind (`pgrep -f claude` / `codex`).
8. In DevTools: `typeof require` → `"undefined"`. Set
   `location.href = "https://example.com"`: it opens in the system browser and
   the app stays on Shiba.
9. `npx @electron/fuses read --app …/Shiba.app` matches D8. Grep both logs
   for the adapter token prefix: no hits.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Google IdP refuses embedded sign-in | T60 spike: UA strip, then Access OTP or GitHub IdP. Long term: system-browser sign-in (not v1). |
| Login-shell env capture hangs or is noisy | Marker plus 10s timeout plus a fallback PATH. "View logs" shows the PATH that was used. |
| electron-builder can't collect pnpm-symlinked deps (`electron-updater`) | Fallback: bundle `main.ts` with the root's `vite` in lib/SSR mode into one file, or set `node-linker=hoisted` for this package only. |
| Unsigned macOS builds: Gatekeeper warning, no auto-update | Internal use until an Apple Developer ID exists (§10). |
| Daemon change regresses CLI users | Additive only. Backend tests never spawn the daemon, so the T61 spawn-based `daemon.test.ts` is the real guard. `--help` path unchanged. |
| Local runs can't see file-based CLI logins (per-run `HOME`) | T62 credential spike with real subscription logins. If it fails, a separate T51 follow-up decides how credentials reach runs (a human decision). |
| Backend fixes in T61 change existing P9 behavior | Both only repair broken paths: better-auth users get 200 instead of a wrong 401, and Access deploys let the daemon through to a route that already self-authenticates. Each gets a test or a drift check. |
| Approvals poll adds backend load | 30s cadence, only while signed in, paused on suspend. |
| Electron security patch cadence | Updater on. Bump `electron` monthly with the dependency audit. |
| Wire-version skew: the bundled daemon vs a newer Worker | `DAEMON_VERSION` is reported but never checked. A changed envelope or result schema answers the old daemon with 400 (`local-dispatch.ts:112-115,155-158`). Ship a desktop release with any wire change, and treat T51 schemas as versioned. |
| Dashboard cancel doesn't reach the daemon | The adapter cancels the DO record, but the daemon never polls status. It runs to the end and its result gets 409 (§11.9), and the tray stays `busy` until then. Acceptable for v1; see §9. |

---

## 9. Not doing (and what would change that)

| Skipped | Revisit when |
|---|---|
| Linux | macOS v1 has shipped and people ask. The daemon already runs on Linux. The work is an AppImage target, an ubuntu CI job, a GNOME tray fallback (no AppIndicator) and an `~/.config/autostart` entry. |
| Windows | The daemon is proven on Windows (pid leases, exec allowlist, quoting). |
| Fully offline / bundled backend | A product decision in GOAL.md. It's a different product. |
| `shiba://` deep links | Never for pairing (a token in a URL breaks D7). Maybe later for "open run". |
| OS keychain for the adapter token | Another local app needs it. Upgrade path: `safeStorage` in main, handed to the daemon via env. |
| `packages/client-runtime` extraction | A second, different UI surface exists. |
| Multi-deployment switcher | Someone actually runs two Shibas. "Change Shiba URL…" covers it. |
| Mac App Store | Never. Its sandbox blocks spawning harness CLIs. |
| Targeting a run at a specific computer | Multi-computer fleets are real. It needs a `machineId` (or harness) filter on `/claim`, which changes the T51 contract. |
| Propagating dashboard cancel to the daemon | Long local runs make the wasted work hurt. The daemon would poll `/api/local/status` for its own sandboxId and kill the harness. |

---

## 10. Open questions (the plan assumes the first answer)

1. **Scope:** the dashboard as an app plus a local runner (assumed), or a Shiba
   with no Cloudflare at all?
2. **Signing:** Apple Developer ID available? If not, v1 is internal-only
   unsigned.
3. **Bundle id:** `dev.shiba.desktop`, or an org id such as `ai.bik.shiba`?
   Changing it after the first release orphans updates.
4. **Access IdP** on the target deployment? It decides the outcome of the T60 spike.

---

## 11. Backend integration

Every Worker call the desktop app causes, traced to the code that serves it.
Citations are `path:line` against the working tree on 2026-10-08. Paths
without a prefix are under `apps/backend/src/`; `daemon:` means
`scripts/shiba-local-daemon.mjs`.

**Actors.** **Main** is the Electron main process. **Renderer** is the
remote-loaded dashboard. **Daemon** is the daemon under `utilityProcess`.
**Worker** is a route handler. **DO** is `LocalDispatch` (one instance, named
`local-dispatch`, `packages/shared/src/local-runtime.ts:29`) or a
`CodingOrchestrator` instance.

**Credential split.** Main and Renderer carry the dashboard session cookie.
Only Daemon carries the adapter bearer. Main never reads the bearer.

**Worker dispatch order** (`index.ts:129-353`):
1. Access JWT rebuild (`:131`)
2. better-auth `/api/auth/*` (`:145`)
3. global identity gate (`:147-161`)
4. `/api/local*` (`:186`)
5. `/api/approvals` (`:195`)
6. `/api/computers` (`:199`)
7. `/api/runs` (`:215`)
8. `/agents/*` (`:309-346`)

The gate lets `/api/local*` through with no identity (`request-auth.ts:74-76`).
That surface authenticates its own requests (`local-routes.ts:39-84`).

### 11.1 F1 · First run and sign-in

```
Main ──loadURL──► Renderer ── GET /app/ ──► Access lane: edge → <team>.cloudflareaccess.com → IdP → back
                     │                     better-auth / loopback: static asset, no Worker gate
                     ├─ GET /api/whoami ──► meta-routes.ts:50-66 → {agent, auth}
                     ├─ 401 {code:"better_auth"} → SPA sign-in → POST /api/auth/sign-in/email (index.ts:145)
                     └─ cookie lands in session.defaultSession (CF_Authorization | better-auth session)
Main ◄─did-navigate── (re-probe, F2; the same cookie jar serves Main's session.fetch)
```

| Lane | Enabled by | Identity source | Unauthenticated `/api/*` | Desktop note |
|---|---|---|---|---|
| Access | `REQUIRE_ACCESS` or `ACCESS_AUD` (`request-auth.ts:23-25`) | Edge-set `CF-Access-Authenticated-User-Email` (`request-auth.ts:27-33,86`). With `ACCESS_AUD`, it is rebuilt from a verified `Cf-Access-Jwt-Assertion` whose issuer must match `*.cloudflareaccess.com` (`access-jwt.ts:6,32-43`) | The edge redirects before the Worker runs. Behind the edge: 401 with no `code` (`index.ts:147-160`) | D6 must allow the team domain plus the IdP hops |
| better-auth | `BETTER_AUTH_SECRET` of at least 32 chars (`packages/auth/src/better-auth.ts:36,49`) plus the `AGENT_AUDIT` D1 database | Signed cookie, verified per request (`request-auth.ts:97-105`) | 401 `{code:"better_auth"}` (`index.ts:151-156`) | `/app/` loads ungated. `/api/computers*` needs FIX-1 (§11.11) |
| loopback dev | **neither** Access (`REQUIRE_ACCESS`/`ACCESS_AUD`) **nor** `BETTER_AUTH_SECRET`. If either is set in `.dev.vars`, localhost no longer skips login | none. `localhost`, `127.0.0.1`, `[::1]` and `*.localhost` pass (`request-auth.ts:16-21,82-84`) | 401 `{code:"access_not_configured"}` off loopback | Identity is `"default"` (`meta-routes.ts:62`), and local runs refuse on that DO (§11.5) |

**Dev loop prerequisites (T60).** The loopback lane only skips login; it doesn't
turn on the local runtime. `apps/backend/.dev.vars` must also set
`SHIBA_LOCAL_RUNTIME=1` and either `PAIRING_SECRET` or `LOCAL_ADAPTER_TOKEN`.
Without the flag, the probe gets 404 (`disabled`). Without either secret,
`pairing-token` gets 503 and `/api/local/*` gets 404 (`computers-routes.ts:98-100`;
`local-routes.ts:45-49`). `apps/backend/.dev.vars.example` lists none of these
three keys today; T60 should add them, commented out.

Because `wrangler.jsonc` routes `app.tryshiba.dev` as a custom domain,
`wrangler dev` must also get `--local-upstream localhost:8788`. Otherwise the
request host is rewritten and every `/api/*` returns 401
`access_not_configured`. With no Docker daemon, add `--enable-containers=false`
too (see the §5 T60 dev loop for the full command).

**Why the SPA works unchanged.** Dashboard calls are relative, same-origin
`fetch`es (`app.tsx:131,223`; `RemoteAccessView.tsx:112`), plus the `/agents/*`
WebSocket (`apps/frontend/vite.config.ts:33`). Electron attaches the cookie to
both by default, exactly as Chrome does.

`/app/` is a static asset (`vite.config.ts:39-40`). `wrangler.jsonc:7-11` sets
no `run_worker_first`, so in the better-auth lane the asset layer serves the
sign-in shell before the gate.

Main's calls go through `session.fetch`, outside the page, so they need
`credentials:"include"` (A5).

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Window | `GET /app/` | static assets | none | Access edge, or none | 200 HTML | `did-fail-load` → setup (T60) |
| Renderer (existing) | `GET /api/whoami` | `meta-routes.ts:50-66` | none | cookie | 200 `{agent, auth:"access"\|"better-auth"\|"none"}` | 3xx/`opaqueredirect` or 401 → SPA sign-in (`app.tsx:227-237`) |

### 11.2 F2 · Deployment probe

```
Main ─ session.fetch GET /api/computers {credentials:"include", redirect:"manual"}
     ─► [Access edge] ─► index.ts:147 gate ─► computers-routes.ts:64
                                             :69 isAuthenticated fails ─► 401
                                             :72 flag/binding missing  ─► 404
                                             :79 ─► DO GET /computers  ─► 200 {computers}
```

The auth check runs before the flag check (`computers-routes.ts:69` comes
before `:72`). A signed-out user therefore never sees `disabled`.

**This probe gates only the daemon.** The approvals poller has a gate of its
own (F6). Local runtime is off by default, so `/api/computers` answers 404 on
most deployments, and approval notifications still have to work there.

| Response | Source | §3.4 state |
|---|---|---|
| 3xx, or `type:"opaqueredirect"` / status 0 | Access edge (handle both, as `app.tsx:227` does) | `signed-out` |
| 401 with `code` | global gate, `index.ts:147-160` | `signed-out` |
| 401 `{error}` with no `code` | `computers-routes.ts:69-71` | `signed-out`. Until FIX-1 lands, this also fires for a **signed-in** better-auth user. |
| 404 | flag off or binding missing (`computers-routes.ts:72-74`). A Worker without the route at all gives the same 404 (`index.ts:350-352`) | `disabled` |
| 405 / 500 | `computers-routes.ts:78` / `index.ts:354-357` | Not in §3.4. Recommend: keep the previous state and retry in 60s. |
| 200 | `local-dispatch.ts:274-280` | `unpaired`, `paired-elsewhere`, or fork → `starting` (decided from `config.json`) |

### 11.3 F3 · Pairing

```
Renderer ─POST /api/computers/pairing-token─► Worker computers-routes.ts:95-116
                                               nonce=randomHex(16), exp=now+15min ─► DO /pairing-nonce (pair:<n>=exp)
Renderer ◄─ {token, expiresAt, connectCommand}  (token = base64url{n,exp}.HMAC-SHA256, :39-44)
Renderer ─shibaDesktop.pair(token)─► Main: stop daemon; fork --connect <configured origin> --pair <token>
Daemon: probeHarnesses (≤4×5s, daemon:433-437) ─POST /api/local/pair {pairingToken,hostname,platform,daemonVersion,harnesses}
        (no bearer) ─► local-routes.ts:52-58 verify HMAC+exp ─► DO /pair: burn nonce, machineId=uuid,
        adapterToken=randomHex(32), store sha256 only (local-dispatch.ts:215-240)
Daemon ◄─ {adapterToken, machineId} ; write ~/.shiba-local/config.json 0600 (daemon:447-452) ; heartbeat ; "polling"
Main ─► Renderer: {ok:true}
```

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Renderer (T63 button) | `POST /api/computers/pairing-token` | `computers-routes.ts:95-116` | `/pairing-nonce` (`local-dispatch.ts:205-213`) | cookie (`:69`) | 200 `PairingTokenResponse` (`packages/shared/src/local-fleet.ts:49-53`) | 401 → `signed-out`. 404 → `disabled`. 503 means no secret is set (`:98-100`): toast (`RemoteAccessView.tsx:146`), state unchanged. 500 means the nonce store failed (`:108`): toast. |
| Daemon (forked by Main) | `POST /api/local/pair` | `local-routes.ts:52-58` | `/pair` (`local-dispatch.ts:215-240`) | HMAC token plus a single-use nonce (`computers-routes.ts:39-62`) | 200 `{adapterToken, machineId}` | 400 bad body (`local-routes.ts:55`; schema `local-fleet-schema.ts:21-27`). 401 bad signature or expired (`:57`), or nonce burned or expired (`local-dispatch.ts:220-221`). 404 flag off or no secret (`local-routes.ts:42-53`). The daemon exits 1 on every one of these (`daemon:466-471`), the same code as a crash (`daemon:54`). The supervisor rule: **any exit of a `--pair` fork before its first `polling` message is a pair failure.** No restart; `PairResult {ok:false, error:<stderr line>}`; state `unpaired`. |

- **Token size.** A token is about 110 chars. The schema allows 1024
  (`local-fleet-schema.ts:22`). The desktop caps at 1024 too (T63).
- **Restarts never re-pass `--pair`.** The token is single-use (the nonce is
  deleted on first use, `local-dispatch.ts:225`). Once paired, the daemon runs
  from `config.json` (`daemon:496-502`), so a restart is a plain fork.
- **Re-pairing mints a new `machineId`** (`local-dispatch.ts:226`). The old row
  stays until it is revoked or pruned after 7 days (`local-dispatch.ts:81-84`).
  `pair()` on a paired machine should revoke the old id first (§11.8).

### 11.4 F4 · Heartbeat and fleet

```
Daemon ─ every 30s (daemon:49,505; first beat at :504) POST /api/local/heartbeat, Bearer <adapterToken>
       ─► local-routes.ts:61-82: bearer ≠ LOCAL_ADAPTER_TOKEN → DO /authorize (sha256 scan, local-dispatch.ts:242-251)
          → body.machineId ≠ token's machineId → 403 (:77-80) ; else DO /heartbeat upsert (local-dispatch.ts:253-272)
Renderer ─ every 10s GET /api/computers (RemoteAccessView.tsx:6,125) ─► DO /computers, status derived at read:
          now−lastHeartbeat > 75s → offline ; activeRunId → busy ; else idle (local-dispatch.ts:47-50; local-fleet.ts:56)
```

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Daemon | `POST /api/local/heartbeat` | `local-routes.ts:73-82` | `/authorize` + `/heartbeat` | per-machine bearer | 200 `{ok:true}` → T61 `heartbeat{ok:true}` | 401 → exit 78 (`daemon:484`) → `revoked`. 403, 400, 404 or a network error is only logged (`daemon:485-486`) and sends `heartbeat{ok:false}`. Two in a row → `offline`. |
| Renderer | `GET /api/computers` | `computers-routes.ts:77-80` | `/computers` | cookie | 200 `{computers}`, newest heartbeat first | as F2 |

**"This computer".** In pairing mode the daemon heartbeats with
`config.machineId` (`daemon:502`). That is the id `/pair` minted
(`local-dispatch.ts:226,239`), so `ConnectedComputer.machineId` equals
`DesktopStatus.machineId`. The `~/.shiba-local/machine-id` file only feeds
env-var mode (`daemon:454-462,502`) and never matches a paired row.

The tray's `offline` (two failed beats, about 60s) and the server's `offline`
(75s) run on separate clocks. They can disagree for about 15s.

### 11.5 F5 · Local run lifecycle

**Correction to the brief.** The composer does not send `runtime:"local"` and
does not `POST /api/runs`. `submitTask` builds chat text (repository, branch,
harness, model, PR flag, task; `app.tsx:788-800`) and sends it over the
orchestrator WebSocket (`app.tsx:805`). The composer has no runtime control:
`TaskComposer.tsx:48-51` lists harnesses only.

`runtime:"local"` reaches the backend in one of two ways:

- **(a) Chat path.** The orchestrator model sets `runtime` on
  `delegate_coding_task` (`orchestrator.ts:239-245`) when the prose asks for
  it. `mintChatGateApproval` freezes it into a `PendingApproval`
  (`orchestrator.ts:1794-1816`). That step doesn't check the flag, so the card
  appears and the run then fails at dispatch.
- **(b) API path.** `POST /api/runs {runtime:"local", harness}` with the
  dashboard cookie. `handleRuns` stamps `X-Shiba-Intake: dashboard`
  (`runs-routes.ts:92-93`), and `queueSlackRun` checks it
  (`orchestrator.ts:1329-1352`). No dashboard UI calls this; the frontend only
  GETs and DELETEs `/api/runs` (`app.tsx:62,840`). See GAP-3 (§11.11).

```
Renderer ─chat─► Orchestrator DO: delegate_coding_task{runtime:"local"} → PendingApproval{runtime}  (also in F6 listing)
Renderer: human approves — chat card addToolApprovalResponse (app.tsx:646) or Approvals view POST /api/approvals (app.tsx:702)
Orchestrator: executeDelegatedTask checks frozen==call runtime, flag=1, isDashboardAgentName (orchestrator.ts:869-876)
  ─► OpenCodeAgent: runtime "local" → LocalRuntimeAdapter (opencode-agent.ts:292-300); envelope, deadline=now+25min (runtime.ts:471-493)
  ─► DO POST /dispatch → pending (local-dispatch.ts:109-123)        [DO-internal stub, no HTTP surface: local-routes.ts:15-16]
Daemon ─POST /api/local/claim (every 3s idle, daemon:47,526)─► DO /claim → {envelope, claimToken} → T61 "claimed"
Daemon: clone, setup/exec under envelope allowlists (daemon:213-230,291-) ─POST /api/local/result {sandboxId,claimToken,result}─► DO settled
Adapter: GET /status every 2.5s (runtime.ts:421,522-580) → harness.verify (runtime.ts:574-577) → PR publish (opencode-agent.ts:330-336)
Renderer ◄─ run record / diff / PR via GET /api/runs
```

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Daemon | `POST /api/local/claim` | `local-routes.ts:61-72,83` | `/claim` (`local-dispatch.ts:125-141`) | bearer | 200 `{envelope:null}` → `idle`. `{envelope, claimToken}` → `claimed` → `busy` | 401 → exit 78 (`daemon:513`) → `revoked`. Anything else retries after 12s (`daemon:516`), and the state is unchanged. |
| Daemon | `POST /api/local/result` | `local-routes.ts:83` | `/result` (`local-dispatch.ts:143-161`) | bearer + claimToken | 200 `{ok:true}` → `settled` → `idle` | 404 run pruned. 409 claim no longer held (the adapter cancelled, or the reaper ran; `:152-154`). 400 bad result (`:155-158`). The daemon makes one attempt and only logs a failure (`daemon:541-547`). State → `idle` either way. |

**What the desktop touches.** It hosts the Renderer, where intake and approval
happen as in a browser, and it runs the Daemon. Main never calls `/api/runs`,
`POST /api/approvals`, or any adapter verb.

**Open T51 question: which logins a local run can see.** The daemon spreads
`process.env` into each run (`daemon:296`), then sets `env.HOME` to the run's
own `runs/<sandboxId>/home` (`daemon:300`; `homeDir` is
`${SHIBA_LOCAL_RUN_ROOT}/home`, `packages/shared/src/local-runtime.ts:207`).
- **Reach the harness:** env-var API keys, and auth stored in the macOS
  Keychain.
- **Don't:** file-based CLI logins under the real `~`, such as
  `~/.codex/auth.json`.

So "the operator's own logins" holds only for env-var or Keychain auth. Shell
env capture (T62) helps with the first; nothing in the app changes the second.
T62 should check this with real `claude`/`codex` logins before §7 is signed
off.

**Refusals that never reach the desktop:**
- **Chat surfaces.** Slack, Telegram, Discord, email, MCP and automations carry
  no voucher, so intake answers 403 (`orchestrator.ts:1336-1341`). Dispatch on
  a `slack:*` or `default` DO is refused (`orchestrator.ts:873-875`;
  `web-sessions.ts:285-292`).
- **Flag off.** 403 at intake (`orchestrator.ts:1330-1335`).
- **Harness that can't run locally.** 400 (`orchestrator.ts:1342-1351`). Only
  `claude-code`, `codex` and `opencode` declare local (`harness/claude-code.ts:196`,
  `harness/codex.ts:147`, `harness/opencode.ts:196`).
- **Loopback dev.** The default session's DO is named `"default"`
  (`web-sessions.ts:197-198`), and `isDashboardAgentName("default")` is false
  (`:290`), so the T60 dev loop must use a named session. The test does this
  (`local-runtime.test.ts:426,441`).

**Targeting.** `/claim` hands the oldest pending envelope to whichever daemon
asks first. It filters by neither machine nor harness
(`local-dispatch.ts:129-132`). Plan §1, "approved `runtime:"local"` runs
execute on this machine", holds only for a one-machine fleet.

### 11.6 F6 · Approval notifications

**Gate.** The poller has its own probe and starts on the first 200 from
`GET /api/approvals`. It doesn't wait for `/api/computers` to return 200, so
notifications work when local runtime is off (`disabled`) or the machine is
unpaired. On 401/3xx it stops and re-probes with the F2 cadence.

```
Main ─ every 30s session.fetch GET /api/approvals {credentials:"include", redirect:"manual"}
     ─► approvals-routes.ts:27-84: isAuthorizedRequest (:32) → fan-out: user DO + session DOs + "default" (:55)
        each DO listApprovals (orchestrator.ts:2472-2492: prunes expired records, may write state)
     ◄─ 200 {approvals: pending, oldest first; decided: ≤25 (DECIDED_APPROVALS_LIMIT, packages/shared/src/approvals.ts:256)}, no-store
Main: new approvalId vs last set (first poll seeds silently) → Notification
Click → win.show(); loadURL(<origin>/app/?tab=approvals) → app.tsx:380-381,393-394 → approvals view
Renderer: the human decides there (POST /api/approvals, app.tsx:702). Main never does (D1).
```

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Main poller | `GET /api/approvals` | `approvals-routes.ts:27-84` | orchestrator `GET /api/approvals` (`orchestrator.ts:2737-2738`) | cookie, via `isAuthorizedRequest`, which works in all three lanes | 200 `{approvals, decided}` | 401 or 3xx → `signed-out` and stop the poller. 5xx or a network error → skip the tick. |

**Fields.** The poller reads `approvalId` (the dedupe key), `kind`
(`packages/shared/src/approvals.ts:45,113`) and `repoUrl`. The body branches on
`kind`:
- **`run`, or `kind` absent:** title "Approval needed", body `owner/repo`
  parsed from `repoUrl`.
- **`email_send` / `email_delete`:** `repoUrl` holds the **mailbox address**
  (`orchestrator.ts:1574,1592`). Title "Email approval needed" and **no body**,
  so the address never reaches a notification (D7).

Chat-gate approvals are listed too (`threadKey` = DO name,
`orchestrator.ts:1802`).

### 11.7 F7 · Run-finished notification

```
Daemon ─parentPort {type:"status", state:"settled", runId, status, exitCode, repoUrl}─► Main ─► Notification ; click → /app/?tab=activity
```

There is no Worker call. Three caveats from the code:

- **`status` is the daemon's own view.** It is `"completed"` or `"error"`
  (`daemon:237-248`). The Worker then runs `harness.verify`
  (`runtime.ts:574-577`) and can still fail the run, and PR publish comes after
  (`opencode-agent.ts:330`). Title it "Local run finished", not "completed"
  (T64, §7 step 4).
- **The daemon's `runId` is the `sandboxId`.** The run record's id is
  `agent-tool:<approvalId>` (`orchestrator.ts:1837`), so a `?run=` link
  (`app.tsx:382-385`) can't be built from it. Linking to `?tab=activity`
  (`app.tsx:389-390`) is right.
- **Emit `settled` after the result POST,** with a flag for whether the Worker
  accepted it. The POST is attempted once (`daemon:541-547`).

### 11.8 F8 · Revoke

```
Renderer ─POST /api/computers/revoke {machineId}─► computers-routes.ts:82-93 ─► DO /revoke-computer deletes computer:<id>
                                                                                (token hash goes with it, local-dispatch.ts:282-291)
Daemon ─ next /claim (≤3s idle) or /heartbeat (≤30s) ─► /authorize misses → 401 (local-routes.ts:66-67)
Daemon ─ revoked() → exit 78 (daemon:52,476-477) ─► Main: revoked, no restart
```

| Desktop component | Call | Handler | DO verb | Auth | Success | Failure → state |
|---|---|---|---|---|---|---|
| Renderer (fleet row) | `POST /api/computers/revoke` | `computers-routes.ts:82-93` | `/revoke-computer` | cookie | 200 `{ok:true}`, even for an unknown id (`local-dispatch.ts:289`) | 400 if `machineId` is missing (`:85-87`). 401/404 as in F2. |
| Daemon (next call) | claim / heartbeat | `local-routes.ts:66-67` | `/authorize` | bearer | none | 401 → exit 78 → `revoked` |

**Revoke during a run.** The heartbeat 401 exits the process mid-execute
(`daemon:505`), so no result is posted (see F9). Revoke never cancels the
machine's claims, because a claim records `claimedBy` (the operator string),
not a `machineId` (`local-dispatch.ts:139`).

**"Disconnect this computer"** revokes on the server first, then clears local
state:
1. `POST /api/computers/revoke {machineId}`. The Renderer can send it, or Main
   via `session.fetch(..., {credentials:"include"})`. It is not an approval
   path, so D1 is unaffected.
2. Stop the daemon. If it is still polling, it exits 78 on its own.
3. Delete `~/.shiba-local/config.json` and keep `machine-id`.

Deleting `config.json` alone leaves the token hash valid and the row listed
until the 7-day prune (`local-dispatch.ts:81-84`). If the revoke fails (for
example, signed out), the app should still delete the file locally and say the
server row needs revoking from the dashboard.

### 11.9 F9 · Failure and cancel edges

| Event | Backend behavior (code) | Desktop |
|---|---|---|
| Quit or stop mid-run (SIGTERM) | **Today.** The daemon exits 143 at once (`daemon:553`) and posts no result. The harness child was spawned non-detached and is never killed (`daemon:175-179`), so it is orphaned. The record stays `claimed`. The adapter polls until `deadlineAt` = dispatch + 25 min (`LOCAL_MAILBOX_TIMEOUT_MS` = 15 + 2×5 min, `runtime.ts:44-45,422,471`), then calls `/cancel`. The run fails with "Local run timed out waiting for the daemon" (`runtime.ts:513-520`). The 45-min claim reaper (`LOCAL_CLAIM_STALE_MS`, `local-runtime.ts:134-136`; `local-dispatch.ts:70-75`) is only the orphan backstop for when the adapter is gone too. It sets `cancelled`, not `pending`, and runs lazily at the start of each DO request (`:107`). On relaunch, the new daemon deletes the dead workspace (`daemon:145-165`) and never resumes it (`/claim` takes only `pending`, `local-dispatch.ts:130-132`). **Planned (graceful stop).** On SIGTERM the daemon kills the active child, then POSTs `/api/local/result` with a failed "daemon stopped" result (the `errorResult` shape, `daemon:237-248`, which passes `localRunResultSchema`) within a 3s budget, then exits 143. The DO accepts it while the claim is still held (`local-dispatch.ts:152-159`). The adapter's next poll (≤2.5s) sees `settled` + `error` and fails the run at once (`runtime.ts:547-554`), so there is no 25-min wait. If the POST fails or misses the 3s budget (offline, 409 after a cancel), behavior falls back to Today. | Exit 143: no restart. The quit path SIGTERMs the daemon and waits for its exit (3s budget plus a margin) before `app.exit()`, so the result POST isn't cut off. Harness grandchildren survive a child-only kill unless the child is spawned in its own process group. |
| Network loss | Claim retries every 12s (`daemon:516`) and heartbeat failures are logged. The server shows `offline` after 75s. A run already in flight continues. If the network is still down at result time, the single POST fails and the run times out at the deadline. | `offline` after two failed beats, `idle` on the next good one |
| Worker redeploy | LocalDispatch storage persists, and daemon calls retry through the rollout. Not verified here: whether the adapter's poll loop (inside an OpenCodeAgent request) survives a redeploy. If it dies, the run row is reclaimed after 45 min with no updates (`RUN_DEADLINE_MS`, `packages/shared/src/runs.ts:202`; `runs.ts:213-221`). **Version skew:** `DAEMON_VERSION` is reported (`daemon:48`) but never checked. A Worker with a changed envelope or result schema answers the bundled daemon with 400 (`local-dispatch.ts:112-115,155-158`). | Logs only. Ship a desktop release with any wire change. |
| Pairing token expired or reused | 15-min TTL (`local-fleet.ts:58`), single-use nonce (`local-dispatch.ts:225`). The Worker answers 401, and the daemon exits **1** with "pairing token expired, reused, or invalid — mint a new one in Remote Access." (`daemon:470`). That is the same code as a crash (`daemon:54`). | Any exit of a `--pair` fork before its first `polling` message counts as a pair failure: no restart, `{ok:false, error}`, state `unpaired`. Restarts never re-pass `--pair`. |
| Flag turned off after pairing | `/api/local/*` answers 404 (`local-routes.ts:42-44`). The daemon keeps retrying and never exits. | Probe 404 → `disabled`. Main should stop the daemon. |
| Run cancelled in the dashboard | The adapter calls `/cancel` (`runtime.ts:509-511`). The daemon gets no signal because it never polls status, so it runs to the end or the deadline, and its result gets 409. | Stays `busy` until the daemon finishes |

### 11.10 F10 · Updates

`electron-updater` checks GitHub Releases. There is no Worker call and no
backend change. The only coupling is the bundled daemon's wire version (see
the F9 skew row).

### 11.11 Backend changes required

**No new endpoints.** The desktop needs two changes to existing code, a route
fix and a deploy-config fix, plus one frontend gap.

| # | Kind | Change | Evidence | Effect if not done |
|---|---|---|---|---|
| FIX-1 | **REQUIRED BACKEND FIX** (existing route, one line; plan: T61) | `computers-routes.ts:69` becomes `if (!(await isAuthorizedRequest(request, env)))`, matching `approvals-routes.ts:32` and `runs-routes.ts:58`. Add a `local-fleet` test with a better-auth env. | The sync `isAuthenticated` never reads the better-auth cookie. With only that lane configured, it returns false for any path outside `/api/auth` (`request-auth.ts:80-88`). The fleet was only smoke-tested on loopback `wrangler dev` (`VERIFICATION.md:350`). | On a better-auth-only deployment, a signed-in user gets 401 on `GET /api/computers`, `POST /pairing-token` and `POST /revoke`. The probe sits in `signed-out`, pairing and revoke fail, and the browser Remote Access view breaks the same way. |
| FIX-2 | **REQUIRED CONFIG FIX** (deploy config, not an endpoint) | Add `"/api/local/*"` to `ACCESS_BYPASS_PATHS` (`alchemy.run.ts:113-125`). This is the same class as `/mcp`: Access is bypassed at the edge, and the Worker authenticates the request itself (exempt at `request-auth.ts:74-76`; checked at `local-routes.ts:39-84`). Extend drift check (e) to recognize `isLocalRuntimePath` (`scripts/check-alchemy-drift.mjs:587-596`), or it reports "has no Worker auth exemption". | `DashboardAccess` covers the whole host (`alchemy.run.ts:126-134`). The drift check's own note says a machine path missing from the bypass "403s at the edge" (`check-alchemy-drift.mjs:564-567`). | On Access-fronted alchemy deploys, the daemon (CLI or app) gets the Access login instead of the Worker: pairing exits 1, and claims and heartbeats fail. |
| FIX-2b | **Operator step (docs)** | On wrangler-path deploys, or any deployment fronted by an externally managed Access app, the operator must add the same path-scoped Bypass for `<host>/api/local/*`. Document this in `remote-access.md` "Turn it on" (`:10-17`) and in the desktop docs (T66). | alchemy manages only its own apps (`alchemy.run.ts:126-142`). `wrangler.jsonc` defines no Access app. | Same as FIX-2 |
| GAP-3 | Frontend (not backend) | A Sandbox/Local control in the composer that adds a `Runtime: local` line to the chat text, or POSTs to the existing `/api/runs` | `TaskComposer.tsx:48-51`; `app.tsx:788-805` | §7 step 3 relies on the model inferring `runtime:"local"` from prose |

### 11.12 Worker configuration the operator sets

| Setting | Read at | Needed by desktop | Notes |
|---|---|---|---|
| `SHIBA_LOCAL_RUNTIME=1` | `env.ts:147`; `computers-routes.ts:72`; `local-routes.ts:42`; `orchestrator.ts:873,1330`; `opencode-agent.ts:295` | yes | Off → fleet routes 404 → `disabled` |
| `LocalDispatch` DO binding | `wrangler.jsonc:132` (migration v9, `:189`); `alchemy.run.ts:209` | yes | Unbound → 404 |
| `PAIRING_SECRET` | `env.ts:155`; `computers-routes.ts:18-20` | this **or** `LOCAL_ADAPTER_TOKEN` | HMAC key. If unset, the Worker uses `LOCAL_ADAPTER_TOKEN`. With neither set, `pairing-token` answers 503 and `/api/local` answers 404 (`local-routes.ts:45-49`). |
| `LOCAL_ADAPTER_TOKEN` | `env.ts:153`; `local-routes.ts:45,63` | no (A4 strips it from the daemon env) | The CLI env-var bearer. Whoever holds it can heartbeat as **any** `machineId`, because the machine check only applies to per-machine tokens (`local-routes.ts:77-80`). For desktop-only fleets, prefer `PAIRING_SECRET` alone. |
| `REQUIRE_ACCESS`, `ACCESS_AUD` | `env.ts:311,316`; `request-auth.ts:23-25`; `access-jwt.ts:36` | Access lane | Alchemy sets them on live stages (`alchemy.run.ts:285,293`) |
| `ACCESS_BYPASS_PATHS` (alchemy), or a manual Access Bypass app (wrangler / external Access) | `alchemy.run.ts:113` | Access lane | Must cover `/api/local/*` (FIX-2, FIX-2b) |
| `apps/backend/.dev.vars` (dev loop) | `.dev.vars.example` lacks these | T60 dev loop | `SHIBA_LOCAL_RUNTIME=1` plus `PAIRING_SECRET` or `LOCAL_ADAPTER_TOKEN`. Leave `REQUIRE_ACCESS`, `ACCESS_AUD` and `BETTER_AUTH_SECRET` unset to keep the loopback no-login lane |
| `BETTER_AUTH_SECRET` (≥32 chars), `AGENT_AUDIT` D1, `BETTER_AUTH_URL` | `env.ts:324,330`; `packages/auth/src/better-auth.ts:36,49` | better-auth lane | `BETTER_AUTH_URL` sets cookie scope and must equal the configured desktop origin |
| `GITHUB_TOKEN` | `orchestrator.ts:878-883` | only for PR publish | |

### 11.13 Existing backend tests per flow

| Flow | Tests (`apps/backend/test/`) | Not covered |
|---|---|---|
| F1 | `better-auth.test.ts:214` "sign-up → session cookie → whoami → sign-out"; `:191` "better_auth when only the built-in lane is configured"; `:149` "stays fail-closed for non-loopback when nothing is configured"; `access-jwt.test.ts:30`, `:43` "strips a forged email header and sets the verified one" | none |
| F2 | `local-fleet.test.ts:159` "/api/computers and /api/local/pair 404 with the flag off" | `/api/computers*` under Access or better-auth (the FIX-1 test) |
| F3 | `local-fleet.test.ts:74` "mints a copyable connect command and exchanges the token exactly once"; `:89` "refuses an expired, tampered, or foreign-secret token"; `:101` "400s a malformed pair body" | 503 with no secret; daemon-side pairing |
| F4 | `local-fleet.test.ts:108` "upserts, reads busy/idle, goes offline past the stale window, and prunes after 7d"; `:128` "a per-machine token speaks only for its own machine; bad shapes 400"; `:137` "env-var mode (LOCAL_ADAPTER_TOKEN) keeps working without pairing" | none |
| F5 | `local-runtime.test.ts:192` "dispatch → claim → result settles; the claimToken is the result credential"; `:279-:335` intake boundary (flag, voucher, forged voucher, harness); `:347-:390` approval gate, including the Slack and `default` DO refusals; `:422` "the authenticated /api/runs path stamps the voucher; an inbound copy is stripped"; `:453`, `:460`, `:476` daemon surface; `:522` "dispatches the envelope, polls to settled, and returns the daemon's result"; `:575` "surfaces a daemon-reported failure as an error, not a completion" | a positive chat-path dispatch on a dashboard DO; the 25-min adapter deadline |
| F6 | `web-sessions.test.ts:833` "handles approvals aggregation and resolution across web sessions"; `:1052` "GET /api/approvals never fans out to a DO named by a forged record" | none |
| F7 | none (no Worker call) | all |
| F8 | `local-fleet.test.ts:147` "removes the machine and its next heartbeat and claim 401" | daemon exit 78; revoke under better-auth (FIX-1) |
| F9 | `local-runtime.test.ts:231` "reaps a claim whose holder went stale"; `:221` "cancel marks the record and a settled record stays settled"; `:553` "cancels the record when the run is aborted mid-poll"; `:565` "fails closed when the record is cancelled under it"; `local-fleet.test.ts:89` (expiry) | the deadline-timeout path; result 409 after cancel; the planned graceful stop (SIGTERM → child killed → failed result accepted by the DO → adapter fails fast) |
| F10 | n/a | all |

No test runs `scripts/shiba-local-daemon.mjs`. Its exit codes (1, 78, 130,
143), retry cadence and single-shot result POST are untested. T61's lock test
would be the first.
