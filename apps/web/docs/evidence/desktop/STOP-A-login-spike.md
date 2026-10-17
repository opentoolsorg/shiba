# STOP-A — local dev-loop + login spike probe

Date: 2026-10-08. Interactive sign-in NOT performed.

## Probe results
| Step | Result |
|------|--------|
| apps/backend/.dev.vars exists (168B) | yes; contains NEITHER `SHIBA_LOCAL_RUNTIME` nor `LOCAL_ADAPTER_TOKEN` (not edited) |
| .dev.vars.example | keys present commented at lines 55-56 |
| Pre-existing process | user's vite (PID 28554) already on :5173, left running; `/app/` → 200 |
| `pnpm dev` (turbo, /tmp/shiba-dev.log) | **FAILED**: `@shiba/backend#dev` exit 1 — "The Docker CLI is needed to build the configured image before running dev but could not be launched" (Docker daemon not running). Turbo then killed frontend/web. Frontend fell to :5174 (5173 taken); web astro :4321 OK. |
| `curl :8788/api/computers` after `pnpm dev` | 000 (backend dead) |
| Extra probe: `wrangler dev --port 8788 --enable-containers=false` (/tmp/shiba-backend-nocontainers.log) | Ready; `/api/computers` → **401** (auth-gated, expected), `/` → 200 |
| `curl :5173/app/` | 200 (user's vite) |
| `SHIBA_DESKTOP_URL=http://localhost:5173 pnpm --filter @shiba/desktop start` (/tmp/shiba-electron.log) | Built + electron main/helper/renderer processes ran ~20s, no crash. Log has no app output (shell doesn't log load). |
| screencapture | FAILED: "could not create image from display" (no display access in this session) → no screenshot; login form render NOT confirmed visually |

All processes I started (turbo, wrangler, electron) were killed; user's vite 28554 untouched.

## Blockers
1. Docker daemon not running → plain `pnpm dev` backend can't start. Start Docker Desktop (`open -a Docker`), or run backend with `--enable-containers=false` (no sandbox containers; fine for login spike).
2. `.dev.vars` lacks `SHIBA_LOCAL_RUNTIME=1` / `LOCAL_ADAPTER_TOKEN` — operator must add (secrets file, not touched).
3. Port 5173 occupied by an existing vite → a second `pnpm dev` moves frontend to 5174; stop the old one first or use SHIBA_DESKTOP_URL=http://localhost:5174.
4. No GUI screenshot capability here → window/login-form render needs a human.

## Manual steps for operator (plan T60 dev-loop + login spike)
1. Start Docker Desktop (or use `--enable-containers=false`). Stop any stale vite on :5173.
2. Add to apps/backend/.dev.vars: `SHIBA_LOCAL_RUNTIME=1` and `LOCAL_ADAPTER_TOKEN=<random>` (see .dev.vars.example 55-56).
3. `pnpm dev`; confirm `curl -i localhost:8788/api/computers` → 401 and `curl -I localhost:5173/app/` → 200.
4. `SHIBA_DESKTOP_URL=http://localhost:5173 pnpm --filter @shiba/desktop start`; window should show the app login form.
5. better-auth: sign in with email+password in the window; confirm session cookie persists across relaunch (cookie encryption fuse enabled).
6. Cloudflare Access (deployed URL): set SHIBA_DESKTOP_URL to the Access-protected host; verify navigation to *.cloudflareaccess.com IdP stays in-app (D6 allowlist) and completes back to /app/.
7. userAgentFallback: confirm Electron UA is accepted by Access; if Access rejects it, verify the token-strip retry path loads /app/ with the fallback UA.
8. IdP fallback: if SSO flow fails, test Access OTP (email code) and GitHub IdP; record which works in-window vs needing system browser.
9. Confirm adapter token never appears in shell logs/URLs (D-invariant).
