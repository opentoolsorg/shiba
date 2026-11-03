# Recent PR implementation verification — 2026-11-02

## Scope and merge state

GitHub reported zero open pull requests in `opentoolsorg/shiba` at inventory and recheck. The requested PRs had already merged. With no narrower scope supplied, verification covered the recent November 1 batch: #171, #172, #176, #177, #178, #179, #180, #181, #182, and #183.

Base: `729c49e5930f10d8b9188ed95df0e29f1ef67b7c` (main when verification started). Work used an isolated worktree; existing edits in the user's checkout were preserved.

The explicitly requested OMX Team skill was read. OMX and tmux were installed, but this Codex session had no `$TMUX` leader context, so no durable Team runtime was launched and no Team state requires shutdown. Native agents performed separate backend, frontend, earlier-PR verification, and independent review slices. The leader integrated and validated their changes.

## Corrections

- Replay complete assistant text after a room socket reconnect; previously the server reset its body while the client retained its old offset.
- Broadcast one failed terminal event for expired room streams so connected viewers clear stale streaming state.
- Propagate extension HTTP/network/invalid-JSON errors instead of silently substituting browser fixtures. Fixtures remain explicitly available to tests.
- Strip auth configuration from new and legacy persisted MCP fixture records.
- Surface clipboard failures when copying an agent template.
- Repair web-session tests to use verified signed Access JWTs, reject forged identity headers, and exercise the current Worker-to-Durable-Object route.
- Align the desktop credential-copy assertion and comment with the existing owner-only read permission (`0400`). Runtime permissions were not changed.
- Fix three lint errors in the merged skills path validation and dashboard accessible groups without weakening validation.

Regression tests reproduced the realtime, client-error, storage, and clipboard defects before their fixes. An independent reviewer rechecked the combined changes and found no remaining blocker within this correction scope.

## Automated evidence

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed, including generated SDK consistency |
| `pnpm lint` | Passed, existing warnings remain |
| `pnpm lint:imports` | Passed |
| `pnpm knip` | Exit 0; reports existing unused-file/dependency warnings |
| Focused backend integration/provider/skills/session checks | 125 tests passed across 11 files |
| Full frontend tests | 551 passed across 85 files |
| Full desktop tests | 201 passed across 18 files |
| Dashboard production build | Passed |
| Marketing Astro build | Passed, 76 pages |
| Earlier dashboard/marketing checks | 28 passed, including 5 built-output marketing/SEO checks |
| Template/dashboard frontend checks | 72 passed during the earlier-PR slice |
| Full backend on untouched base | 106 failed, 3456 passed, 5 skipped |
| Full backend with corrections | 96 failed, 3472 passed |
| Failure-name comparison | Every remaining failure also occurs on untouched base; 10 session failures resolved; no new failing cases |
| `git diff --check` | Passed |

The full repository suite is **not green**. Remaining backend failures span auth/provider fixtures, approval/run routes, dashboard SSR assumptions, email, and related paths. They are baseline failures, not a claim that each is harmless. Five dashboard SSR failures still expect the old composer/empty-state structure after the shell replacement. The untouched baseline skipped built-output cases because its separate worktree had no built web assets.

## Real local runtime evidence

The isolated checkout ran Wrangler with containers disabled on port 8788 and Vite on port 15173. Local D1 migrations through `0009_org_extension_skills.sql` applied successfully.

- Dashboard HTTP response: 200.
- Identity API: 200, local default identity.
- Runs and approvals APIs: 200.
- Skills: create 201; read, edit, move personal-to-workspace, archive, restore, and versioned final read all 200 using the actual local Worker and D1.
- Realtime: created a session over HTTP, opened two actual WebSocket clients through the Worker, received the expected streamed text on the second client, and received its terminal frame.
- Task submission without model credentials: refused with 400 and no run started. No model execution or sandbox approval was attempted.

These are local HTTP/WebSocket checks, not deployed acceptance tests. Browser automation could not connect because the browser access host was unavailable. Browser navigation and visual behavior are not claimed verified.

## Remaining implementation and live-acceptance gaps

1. **#182 is a UI implementation with absent backend APIs.** `/api/v1/extensions/mcp-servers` and `/api/v1/extensions/connectors` return 404 on the real Worker, as already documented in `docs/EXTENSIONS_API.md`. The corrected client reports the failure; real MCP CRUD, connector persistence, and their scope/OAuth lifecycle do not work end to end yet.
2. **#181 curated workflow Run buttons navigate only.** The curated list in `AppNavRail.tsx` opens Automations; it does not launch the advertised workflow.
3. **#176 template metadata does not install skills/plugins.** Template use/import creates a custom agent, which is the documented contract; referenced skill/plugin installation is not proven or implemented by that flow.
4. **#177/#183 live integration execution remains unverified.** It requires a configured OpenConnector sibling Worker, runtime/admin credentials, provider OAuth clients, live connection isolation, and exact approved action execution.
5. **Real task execution is environment-blocked.** No model gateway or connected subscription was configured in this isolated local test. Containers were disabled; model, sandbox, and Slack delivery acceptance were not performed.
6. **Preview cleanup after #177 failed** because deployment authentication/bootstrap configuration was absent. No Cloudflare production deployment, remote resource change, or real-secret operation was performed during verification.

No statement in this report certifies all merged features as production-ready or fully browser-tested.
