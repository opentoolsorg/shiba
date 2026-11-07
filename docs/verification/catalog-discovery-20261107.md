# Catalog discovery and connection feedback

## What the screenshot showed

The Connectors page placed the provider/reference directory after every expanded MCP setup form. The same screenshot showed `Authenticated owner required.`, the provider routes' 401 response when no verified owner session is available. The screenshot contained six presets; PR #199's later source contains eight. The screenshot does not establish which deployment or commit served it.

The directory placement and unclear error states are UI defects. Missing owner authentication, an unavailable OpenConnector sibling, or absent deployment bindings are independent setup problems. This patch changes no owner authentication, service binding, credential, grant or approval rule and does not make an undeployed sibling available.

## Changes

- Keep personal accounts compact and put discovery directly below them. MCP credential forms remain in the MCP tab, linked from discovery.
- Use responsive cards with Shiba's existing tokens and verified brand assets. Separate reference entries, native/MCP configuration and provider sign-in readiness.
- Send searches and Ready-to-connect filters to the provider, retaining pagination and stale-response fencing. Add a filter reset and make the header search focus discovery rather than account filtering.
- Keep 401 owner sign-in and 503 service-setup failures visible. Failed catalogs are not described as empty; the catalog dialog offers retry.
- Keep connection progress, errors and successful confirmation visible inside the catalog dialog. Prevent concurrent Connect clicks and refresh catalog rows only after a verified owner-account revision.

Overlay's compact connected/available sections and reusable cards informed the hierarchy. No Overlay code or assets were copied. Reference: `LayerNorm/overlay-web` at `1799597ac60ea02fe6479a517acdce5138f2aee0`, `packages/overlay-modules-react/src/extensions/integrations.tsx` and `catalog.tsx`.

## Verification

The work was replayed onto PR #199 checkpoint `bf828b0a2c3dded3e91333c9e9bbce658ee43aab`, preserving its brand logos and authority registry.

- Full frontend suite: 1,545 tests across 189 files passed. Tests use synthetic fixtures, not live accounts or provider services. The runner printed existing timeout/aborted-fetch and localhost teardown diagnostics but exited successfully.
- Frontend TypeScript, frontend ESLint/import rules and Knip passed. Changed-file Biome passed with warnings. Root lint separately exposed 45 SVG accessibility errors from the preceding logo checkpoint; a follow-up cleanup handles these.
- Frontend production build and prerender passed. An earlier build attempt was killed while the full test suite ran concurrently; the standalone rerun passed.
- Regression coverage includes catalog visibility, server search and readiness filtering beyond the first loaded page, filter reset, missing owner authentication, 503/retry, separate native/MCP and provider readiness, popup-blocked feedback inside the dialog, concurrent-connect prevention, verified-success refresh, actor-change fencing and existing reconnect/disconnect flows.
- Chromium could not start because this execution environment denied its local process socket, including an escalation attempt. No browser page was opened and no visual/responsive screenshot pass is claimed. Desktop/tablet/mobile light/dark visual QA remains to be run on an environment where Chromium can start.
- No full backend runtime suite, live-account consent, sibling deployment, vendor action or production deployment was performed. This is not a full repository/live end-to-end acceptance claim.
