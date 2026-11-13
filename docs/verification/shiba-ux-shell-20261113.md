# Five-area workspace shell — November 13, 2026

This shell slice starts at `f363e79825b6c1e481bf5a9dfa4b5f561d83d819` (fresh `origin/main`, after PR #203). It groups the existing dashboard destinations into five areas and retains each view and its contextual controls.

| Area | Existing view IDs / canonical flat paths |
| --- | --- |
| Work | `work`, `tasks`, `approvals`, `diff`, `swarm`, `dashboard` |
| Chat | `threads`, `collaboration` |
| Team | `custom-agents`, `employee-tools`, `providers`, `skills`, `agents`, `team` |
| Knowledge | `memory`, `spaces` |
| Settings | `settings`, `integrations`, `inbox`, `automations`, `activity`, `analytics`, `remote` |

A view ID maps to `/<id>/`. Chat keeps both current conversation surfaces together; Dashboard and Integrations remain accessible. The five-area rail and contextual destinations use the same typed mapping in `apps/frontend/src/app-navigation.ts`. The mobile drawer contains every destination, existing agent/thread actions, search, workspace selection and account controls. Approval badges consume the existing scoped approval counts.

## Routing contract

The existing TanStack Start splat route and `/app/` static shell remain intact. The router has no basepath. The Worker currently serves the shell for known single-segment dashboard paths and `/spaces/<id>/`; no production Worker, authentication, deployment or generated route-tree file was changed.

Nested routes such as `/work/approvals/` are intentionally not introduced: hard refresh would require a Worker fallback change outside this task's scope. Use the working `/approvals/` path. Legacy `/app/?tab=<id>` and `/app/?view=<id>` selectors remain supported, including the `run-registry`, `orchestrator` and `mailbox` aliases. Existing run, prompt and validated room-link precedence stays in `app.tsx`. Work layout/task selection remains owned by WorkView.

Initial URL normalization retains existing callback query parameters and fragments, including on Settings. Normal view changes continue through the existing TanStack history integration. OAuth/bootstrap/Slack callback handlers are unchanged.

## Integration notes

- `layouts/AppShell.tsx` provides shared navigation context; existing context panels render area links above their own controls.
- `components/WorkLeftPanel.tsx` has only a two-line shell adapter: import `AppAreaNavigation` and render it before the existing header. Preserve this slot when integrating Work changes. No WorkView, task inspector or Chat feature implementation was changed by this slice.
- `app.tsx` owns the shell wrapper, routing helper extraction, callback URL preservation and the fallback area sidebar for views without a dedicated context panel.
- Three backend **test** files follow the relocated navigation data and five-area labels. Backend production code is unchanged.
- No new runtime dependencies, Overlay code/assets, provider logic or memory behavior were added. Existing hard-coded demo workflow rows and the unconditional “Worker Online” navigation claim disappeared with the old navigation renderer.

## Verification

- All 23 destinations are covered by mapping/flat-route round-trip tests and desktop/mobile navigation tests.
- Focused navigation, app, room-link, OAuth and Slack route tests cover the existing behavior and callback preservation. Backend host-routing and dashboard SSR tests pass (59 tests).
- The final complete frontend suite passes: 199 files, 1,694 tests.
- Frontend typecheck, ESLint for the changed components, changed-file Biome checks and `git diff --check` pass.
- Repository lint and import lint pass. Repository typecheck, root TypeScript build and SDK type synchronization pass. Astro needed `XDG_CONFIG_HOME` under `/tmp` and Turbo `--env-mode=loose` to forward that local environment setting; the default strict invocation could not create `/home/agent/.config/astro`.
- The main client entry shrank from 2,294,776 to 2,265,523 bytes against a separately built checkout of the base SHA (29,253 bytes smaller; 3,617 bytes smaller with the same gzip compressor). The existing large-chunk build warning remains. Runtime memory was not benchmarked.
- The full build graph, static asset assembly, docs/link validation and built-site tests pass (7 built-site tests). No deployment was performed.
- Production-build Chromium checks pass at 1440×1000 (dark), 1024×768 (light), 768×1024 (light) and 390×844 (dark). They check area navigation, flat-route refresh, collapse/reload, mobile destinations, keyboard focus trapping, account-menu Escape, drawer Escape and trigger-focus restoration. No page overflow or uncaught render errors were observed. APIs used explicit empty/error fixtures; first-run seed POSTs were intercepted and rejected. These checks do not demonstrate live backend execution or vendor access.

Repository CI checks pass with the configured Knip threshold. Knip reports identical findings on this branch and a detached checkout of the base SHA. `env:load` requires an unset `CLOUDFLARE_ACCOUNT_ID`; no dummy account or credential was supplied. Live auth/provider/backend execution was not exercised.
