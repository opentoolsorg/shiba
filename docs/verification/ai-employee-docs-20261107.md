# AI employee documentation refresh — 2026-11-07

## Scope

Based on `main` at `10360a3694471b485ab16426689a8e6800e89611`, after PR #199 merged. No application behavior, credential, permission, feature flag, migration, or deployment changed.

- Lead with AI employees, concrete job outcomes, a first draft, and review rather than installation internals.
- Explain repository tasks, repository-free artifact workspaces, and employee app tools as different work targets.
- Use the current **Agents** navigation while retaining real **Create bot** / **Launch bot** button labels.
- Add beginner guides for connections/tool access and team workspaces. Preserve account ownership, sharing, grants, and action-approval distinctions.
- Correct the old claim that initial run approval authorizes GitHub publication. Publishing uses a separate approval of the completed snapshot.
- Correct browser-only skill storage guidance; explain instruction skills and reviewed, versioned run-attached skills separately.
- Preserve all existing documentation URLs and advanced references. Add a dated evidence guide rather than presenting September counts as current acceptance.
- Align the README and `llms.txt`; make narrow source-backed corrections to Node, orchestrator-model, container-size, and removed Devin claims.

## Verification

- Web tests: **12 passed**, including five new documentation regression tests.
- Astro diagnostics: **173 files**, zero errors, warnings, or hints. The build still reports existing OpenAPI metadata and optional-partials warnings outside these diagnostics.
- Complete production build: **6 tasks passed**, including dashboard prerender and Astro output.
- Documentation route verification passed, including generated Markdown, API pages, and search.
- Assembled public output: **96 HTML pages, 7,300 local links/assets/anchors** verified; **56 Markdown files** checked for stale claims.
- Built marketing/SEO tests: **6 passed** after aligning the overview breadcrumb assertion with the new navigation label.
- Package typechecks and import lint: **18 tasks passed**. Root TypeScript build and SDK generated-type consistency also passed.
- Root Biome CI and Knip exited successfully with existing repository warnings/reports. Changed configuration, machine-readable intro, and tests passed focused Biome without fixes.
- Aggregate tests did **not** complete. The full frontend suite finished with **1,556 passed across 189 files**. Sandbox (86), SDK (14), ACP server (9), login (3), read gateway (150), desktop (202), and auth (12) suites also finished successfully.
- Before interruption, the backend reported failures in the unchanged direct-execution intake assertion in `phase1-core-loop.integration.test.ts` and the unchanged overview expectation in `dashboard.test.ts`. No full-backend total or green aggregate result is claimed.
- The full-suite continuation was blocked because its live Typesafe call could send task/classification data outside the local test environment without verified authorization. That operation was not retried; no live acceptance is claimed. The test process was no longer available when cancellation was requested.
- Independent source review found two small navigation/copy clarifications (team instruction skills and saved-task copying); both were incorporated.

## Limits

This is source, test, and static-build verification. No live model, connected provider, account consent, external action, or deployment was tested. No new browser screenshots or live visual acceptance are claimed. Historical advanced-reference sections retain their dated context; this is not a complete revalidation of every runtime authentication guide.
