# Marketing header: GitHub stars

## Delivered

The shared marketing header replaces its Self-host action with the GitHub mark,
a star icon and a count fetched in the visitor's browser from the public
`opentoolsorg/shiba` repository. The link and the footer repository link use the
canonical organization URL. Self-hosting guides and in-page setup actions remain
available.

This is a runtime request, not a number captured during the static Astro build.
Counts are fetched on page visits, with successful reads cached for 15 minutes.
It is not a continuous or push-based feed. No GitHub token, user credential or
referrer is attached to the request.

## Failure and accessibility behavior

- A four-second timeout bounds requests. Invalid data, network errors, rate
  limits and storage failures leave a usable GitHub link.
- After a failed request, a five-minute cache cooldown avoids retrying on each
  page navigation. A last-known count is retained for at most 24 hours and is
  described as such in its accessible name and tooltip.
- A first visit without a usable count, including without JavaScript, displays
  “Star” rather than a fabricated zero. A real count of zero is valid.
- The accessible name includes the exact count even when the visible number is
  compact. Icons are decorative, keyboard focus is visible, and the link has a
  44px minimum touch height. It navigates in the same tab.
- The mobile header uses its available width. At 360px and below, the mascot
  remains the home link while its redundant wordmark text is hidden to leave
  room for menu, theme and GitHub controls.

## Verification

Checked against the documentation branch based on `c037504f`:

- Web tests: 25 passing, including 13 new tests for runtime request options,
  count validation, fresh/expired/stale caches, storage failure, rate-limit
  cooldown, timeout, zero and decreasing counts, accessibility, and fallback.
- Astro check: 176 files, zero errors, warnings or hints in diagnostics.
- Production Astro build: 93 pages built successfully.
- Docs route verification: existing docs URLs, agent Markdown, API reference,
  search assets and landing page present.
- Built marketing and SEO tests: 7 passing across two test files. The new
  regression checks the generated header on home, story, integrations, waitlist
  and blog pages, including the real repository URL and no invented static count.
- Biome on changed TypeScript/test files: no diagnostics. Repository-wide lint
  exits successfully with existing warnings. Knip exits successfully and its
  output matches the unchanged base checkout exactly.
- No new dependencies, credentials, Worker endpoints or deployment bindings.

The installed pnpm wrapper tried to auto-install dependencies into a
non-writable home directory. Verification used the already installed binaries
and the same Node test commands directly instead.

Browser visual and interaction checks were attempted but remain unverified:
Chromium cannot create its required socket in this executor, and the available
browser cannot reach the isolated local preview. Mobile/light/dark appearance,
menu interactions and a real GitHub response should receive browser review
before release. Mocked requests establish the client behavior, not GitHub's
current star count or production network availability. The complete monorepo
typecheck/test/build gate was not run for this isolated header change; integration
must run the aggregate gate on the combined branch. Nothing was deployed.
