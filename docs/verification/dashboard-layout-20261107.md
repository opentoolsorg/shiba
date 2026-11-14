# Dashboard layout refinement, 2026-11-07

## Scope and reference

Implemented on PR #199 checkpoint `22edd8b709a9f14176bc5a5ee6a5463eb1bdf256`.

The layout follows a stable primary navigation, contextual sidebar, and focused content canvas. The notes were taken from an external app shell at commit `8c57d1c521a9ffb332bad1def201ab29d9869066` (app shell, sidebar composition, and contextual Work navigation). Those paths are not vendored here.

This is an independent Shiba implementation. No outside brand, asset, dependency, or source component was imported. It retains the current PR's neutral light/dark tokens, Shiba mascot, routes, account isolation, and execution contracts.

## Changes

- Readable primary navigation labels and a direct Insights destination, including the real pending-approval count. Related Insights pages highlight that destination. Existing More, account, collapse, theme, keyboard and mobile navigation remain available.
- Clear workspace identity and a discoverable command-menu control in the outer chrome. Context panels use one width, quieter surfaces, larger navigation targets, and consistent spacing. The Work context panel now follows the same desktop breakpoint as its header controls instead of squeezing the tablet canvas.
- An action-first Dashboard with a clear heading, run summary, and a next-step panel that prioritizes approval review, then provider setup, then Work. The overview navigates to owning surfaces; it cannot grant approval or start execution.
- Recent work, pending review, and registered MCP principals have distinct hierarchy. Workspace shortcuts lead to integrations, context and agents. Empty and failed-history states stay distinct, and unavailable run history does not display misleading zero/success metrics.
- Container-based responsive layout, narrow-screen stacking, compact-height rail sizing, visible focus, token-based dark mode and existing reduced-motion support. No integration-catalog behavior or backend implementation changed.

## Verification

All execution was local with existing installed dependencies. Package binaries were used directly because the pnpm shim tried to reinstall dependencies into an unavailable home-directory store.

- Final full frontend Vitest suite: **1,550 tests across 189 files passed** (85.76 seconds). An earlier full run passed the same set. The suite emitted existing happy-dom teardown/network diagnostics but exited successfully.
- Final focused regression suite: **118 tests across seven files passed**, covering AppNavRail, DashboardView, WorkView, WorkHeader, WorkLeftPanel, InsightsPanel, and app integration. Coverage includes sidebar collapse/focus, Escape restoration, new Insights navigation, approval-first next steps, setup routing, empty/unavailable history, real metrics, recent-run ordering, and workspace shortcuts.
- Frontend TypeScript and full frontend ESLint: **passed**.
- Frontend production client/server build and `/app` prerender: **passed** after final edits; existing large-bundle warning remains.
- Repository Biome CI and Knip: **passed with warnings**, not a warning-free claim.
- `git diff --check`: **passed**.

### Browser and live limits

Local Vite preview started at `http://127.0.0.1:5197/`. Chromium failed before opening a page: the environment refused its process singleton socket (`Operation not permitted`) and crash-report storage was read-only. The attempt was not retried with weaker isolation or another route. No new screenshot was captured.

Therefore desktop, tablet and mobile rendered appearance, light/dark pixel contrast, overflow, and actual browser click/keyboard behavior remain **unverified**. Vitest uses fixture data in happy-dom, not a live backend. No live provider, real account consent, sandbox execution, deployment, or production approval was exercised. Full backend tests and the repository's unrelated build/type/environment gates were not rerun for this frontend-only patch; the integrating branch should run its aggregate gate.
