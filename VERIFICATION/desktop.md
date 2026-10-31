# Shiba Desktop — verification checklist

**Status:** local prototype. Automated unit coverage is green; **live macOS acceptance** below is still required before calling Desktop “accepted” on a real deployment.

**Related:** `DESKTOP-PLAN.md` §7, `VERIFICATION.md` (2026-10-08 desktop summary), evidence under `apps/web/docs/evidence/desktop/`.

---

## Automated path (CI / agent — no real Electron window required)

Run from repo root:

```bash
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built && pnpm check:ci
```

Targeted desktop + local-runtime slices:

```bash
pnpm --filter @shiba/desktop test          # controller, pairing, poller, tray, daemon spawn
pnpm --filter @shiba/frontend test -- --run src/desktop-status.test.ts src/desktop-connection-label.test.ts src/local-run-target.test.tsx
pnpm --filter @shiba/backend test -- local-fleet.test.ts local-runtime.test.ts
```

Optional (needs display + built desktop; Linux CI uses `docs/audits/desktop-web-e2e.md`):

```bash
pnpm -C apps/desktop build
pnpm --filter @shiba/desktop test:e2e      # smoke: setup, bridge, no Node in renderer
```

Optional full local-daemon UI driver (isolated Worker, disposable account — **never point at production**):

```bash
# See .cursor/skills/verify-shiba/SKILL.md and docs/audits/local-runtime.md
VERIFY_DESKTOP=1 node .cursor/skills/verify-shiba/scripts/drive-local-runtime.mjs
```

**What automation proves**

| Step | Evidence |
| --- | --- |
| Login/session reaches `/api/computers` | `local-fleet.test.ts` better-auth session → 200 |
| Pairing token → daemon argv | `apps/desktop/test/pairing.test.ts`, `daemon.test.ts` |
| Bridge + status IPC | `pairing.test.ts`, `desktop-status.test.ts` |
| Local run intake + `targetMachineId` | `local-runtime.test.ts`, `local-run-target.test.tsx` |
| Approvals poller (no approve from notification) | `approvals-poller.test.ts` |
| Run-finished notification on `settled` | `run-notify.test.ts` |

---

## Operator setup (before manual Desktop acceptance)

1. Worker: `SHIBA_LOCAL_RUNTIME=1`, `LocalDispatch` bound, `PAIRING_SECRET` or `LOCAL_ADAPTER_TOKEN` set.
2. **Access-fronted deploys:** bypass policy on `<host>/api/local/*` (alchemy `MachineBypass` or manual equivalent). Without it, pairing gets HTML login pages, not JSON.
3. **Better-auth deploys:** `BETTER_AUTH_URL` must match the Shiba URL configured in the desktop app.
4. Dev loop (no Access): `wrangler dev` with `SHIBA_LOCAL_RUNTIME=1` in `.dev.vars`; use `--local-upstream localhost:8788 --enable-containers=false` when custom domain routes break loopback auth (see `DESKTOP-PLAN.md` §7 notes).
5. Pair **one** computer for acceptance ( `/claim` is oldest-first with no machine filter when multiple daemons exist).

---

## Manual acceptance (macOS + real deployment)

Record a dated pass/fail in `VERIFICATION.md` when complete. Do **not** claim this from Linux CI alone.

| # | Action | Pass when |
| --- | --- | --- |
| 1 | Install unsigned `.dmg` or `pnpm --filter @shiba/desktop dist:local`; first launch via right-click → Open | Setup URL → sign in → dashboard loads |
| 2 | Remote Access → **Connect this computer** | Connections row shows **This computer · idle**; fleet row has **This computer** badge + harness pills; tray **Connected · idle** |
| 3 | Hide app; queue task with **Run on: This computer** (claude-code or codex) | Approval notification within ~30s; click opens Approvals |
| 4 | Approve | Tray **Running · owner/repo**; then **Local run finished**; diff/PR in dashboard when verify completes |
| 5 | Revoke machine in fleet | Tray **Revoked · reconnect**; daemon does not auto-restart; reconnect works |
| 6 | Start CLI daemon while app daemon runs | Second process exits **75** (lock) |
| 7 | Quit during busy run | Confirm dialog; run fails **daemon stopped** quickly; no orphaned harness (`pgrep`) |
| 8 | DevTools: `typeof require` → `"undefined"`; navigate to `https://example.com` | Opens in system browser; app stays on Shiba |
| 9 | `npx @electron/fuses read --app …/Shiba.app` | Matches D8 list in `DESKTOP-PLAN.md` |
| 10 | Grep `main.log` + `daemon.log` for adapter token material | No hits |

---

## Remaining manual blockers (honest)

| Blocker | Notes |
| --- | --- |
| **Apple signing / notarization** | Required for frictionless Gatekeeper + auto-update; agent scope is unsigned local `dist:local` only |
| **Real Access bypass on production** | Must be verified on the operator’s stage, not loopback `wrangler dev` |
| **Credential spike (T62)** | Subscription logins under per-run `HOME`; blocked-for-manual |
| **STOP A login spike** | Real IdP in Electron window; evidence in `apps/web/docs/evidence/desktop/STOP-A-login-spike.md` |
| **Tray / notification UX on macOS** | Unit-tested only; not exercised in headless CI |

---

## Failure modes (operator)

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Probe stuck **Sign in to Shiba** | Session cookie not on configured origin | Sign in again; `BETTER_AUTH_URL` vs app URL |
| **Local runs disabled** | Flag off or DO unbound | `SHIBA_LOCAL_RUNTIME`, `LocalDispatch` |
| Pair exits “expired, reused, or invalid” | Token TTL or reuse | Mint new token; clock skew |
| Daemon logs HTML / Access page | Missing `/api/local/*` bypass | Access app + `remote-access.md` |
| Fleet 401 in browser | Auth lane mismatch | T61 `isAuthorizedRequest` path; session |
| Run never claims | Multiple daemons / wrong machine | Single paired computer; pin `targetMachineId` in composer |
| Notification but run stays pending | Expected — notifications do not approve | Open Approvals tab and approve on card |
