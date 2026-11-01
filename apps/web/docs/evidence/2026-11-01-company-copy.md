# AI slop cleanup report — user docs and company-wide copy

## Scope

The everyday documentation and public marketing copy in the marketing worktree. Position Shiba as AI employees for company work across engineering, design, marketing, sales, operations, finance, research, and revenue planning. Keep operator/developer material available separately. No backend behavior, real account configuration, or publishing changed.

## Behavior lock

Before editing, the existing production docs checks passed in 55 cases, the generated link scan passed 4,524 references, and five built marketing/SEO tests passed. Preserve URLs, linked anchors, native menu/search/theme behavior, form consent and submission, the simulated demo's approval boundary, repository requirements, and factual feature limits.

The waitlist submit script was compared with the task's saved source baseline and is unchanged. The final browser checks submitted no forms and invoked no live operations.

## Cleanup plan and review

Plans were recorded in `.omx/context/docs-plain-language-20261101.md` and `.omx/context/company-wide-copy-20261101.md` before the corresponding edits. An independent reviewer approved both plans, then reviewed the resulting copy separately from the writers.

Copy-editing passes covered clarity, voice, reader value, proof, specificity, calm human tone, and clear next steps. No fabricated customers, prices, performance figures, or business results were added.

## Fallback findings

- Starlight's native mobile/no-JavaScript navigation and legacy URL redirects: grounded compatibility paths; preserved and verified.
- Browser-local saved Skills: an actual product limitation, explained once where users manage their notes.
- Per-page integration-description override/fallback mapping: unnecessary duplicate copy source; removed in favor of the existing canonical catalog. No runtime recovery or authorization fallback was added.
- No masking runtime fallbacks were changed. Existing fail-closed automation conditions remain documented in the technical reference.

## UI/design findings

- Removed the redundant welcome component, eyebrow/tagline stack, repeated navigation grids, and decorative five-step strip. The welcome page now uses native docs content with two distinct starting actions.
- Kept original Shiba characters and the role gallery as intentional brand elements. Every example identifies whether it is one of four actual presets or a custom role.
- Kept technical navigation collapsed and separate from everyday task guides.
- Finance/revenue examples are drafts based on supplied information. Copy does not claim accounting sync, payments, autonomous CRM updates, financial correctness, or revenue outcomes.

## Passes completed

1. Removed unnecessary user-facing internals and obsolete or unsupported copy.
2. Moved useful setup/reference material out of main guides; consolidated repeated guidance and copy sources.
3. Applied the seven copy-editing sweeps and independent factual/editorial corrections.
4. Rechecked generated routes, links, anchors, search, native controls, simulation interactions, forms, and responsive rendering.

Everyday copy across 16 guides decreased from 10,156 to 4,355 whitespace-delimited words, approximately 57% shorter. The technical details remain in reference pages rather than being presented as beginner steps.

## Changed files and simplifications

- `apps/web/src/content/docs/docs/overview.mdx`, `getting-started.md`, `employees.md`, `skills.md`, `dashboard.md`, `remote-access.md`: direct task guidance, plain role examples, short next actions.
- `approval-gates.mdx`, `review.md`, `automations.md`: actual approval/review/recipe controls; removed an invented approval endpoint, duration estimates, and an absent Missions screen.
- `github.md`, `slack.mdx`, `telegram.mdx`, `discord.mdx`, `linear-agent-session.md`: user connection flows separated from installation steps; corrected stale GitHub, Slack, and Linear claims against source.
- `costs.md`, `troubleshooting.md`, `product-status.md`: user-facing cost/help/status explanations, with technical details linked separately.
- New references: `task-settings.md`, `remote-access-setup.md`, `automation-reference.md`, `review-reference.md`, `github-setup.md`, `slack-setup.md`, `telegram-setup.md`, `discord-setup.md`, `linear-setup.md`, `runtime-limits.md`, `implementation-status.md`.
- `apps/web/astro.config.mjs`, `components/starlight/Header.astro`, `styles/docs-shell.css`: clearer audience navigation; removed unused welcome styling. The unused `DocsWelcome.astro` component was deleted.
- `pages/index.astro`, `components/HeroDemo.astro`, `components/AgentCast.astro`: company-wide positioning and honest custom Finance/Revenue examples; simulated controls retained.
- `pages/why-shiba.astro`, `open-source-devin-alternative.astro`, `waitlist.astro`: shorter story, practical evaluation questions, clearer signup copy without changing submission behavior.
- `pages/integrations.astro`, `data/integrations.ts`, `pages/network.astro`, `pages/blog/index.astro`: consistent company-work language and canonical catalog copy.
- `layouts/MarketingPage.astro`, `components/starlight/Head.astro`, `pages/llms.txt.ts`, `README.md`, `scripts/generate-og.mjs`, and the generated social image: aligned descriptions, links, and public previews.
- `.agents/product-marketing.md`: records audience, voice, and source-grounded feature boundaries. `.gitignore` allows that repo-authored context file.
- `apps/backend/test/marketing.test.ts`: existing copy expectations updated to the requested positioning; functional and safety checks retained.

Legal policy text and dated journal articles were intentionally left unchanged. Existing unrelated worktree modifications were preserved.

## Team evidence

The requested Team skill requires “a leader session with `$TMUX`.” This session has no tmux leader, so no OMX Team runtime, pane, mailbox, task count, or shutdown is claimed.

Native subagents completed three disjoint documentation writing lanes, then three marketing writing lanes, with an independent reviewer for plans and final copy. All children reported completion before final integration. Runtime shutdown/state cleanup is not applicable; no Team runtime was launched.

The final four-lens review approved the copy: UX clarity 9/10, brand consistency 8.5/10, skeptical new customer 8.5/10, finance/revenue claim scrutiny 9/10. These are editorial judgments, not product-performance evidence.

## Quality gates

- PASS: typecheck, lint, import lint, CI static checks, deploy-configuration drift check, environment validation, secret scan, and whitespace checks. Existing non-blocking static warnings remain.
- PASS: production build; 78 assembled HTML pages, 5,919 generated local link/asset/anchor references, Pagefind search, and 55 markdown files checked for stale claims.
- PASS: focused built marketing/SEO suite, eight tests; built-page check, one test.
- PASS: 49 marketing browser checks and 55 docs browser checks, covering 390/768/1440px, light/dark, hero role switching, simulated approval/rejection, Finance preview, integration search/filter/empty/reset behavior, form presence, and no-JavaScript content/navigation.
- PASS: API design checks at 390/768/1024/1440px in both themes, including clipboard copy and keyboard disclosure.
- FAIL: full workspace suite. Two existing daemon deadline tests failed under the broad run (`local-daemon-control.test.ts`, `local-daemon-cancel-phases.test.ts`). Both files passed together in the focused rerun, seven tests. No daemon source or tests changed. The full suite is not reported as green.

One docs browser pass encountered a temporary 404 while an existing marketing test rebuilt Astro output. The checks were rerun after the build completed; final checks passed against stable production output.

## Remaining risks and preview

Unresolved: the existing full-suite daemon timing failures, and previously documented live-provider/deployment acceptance gaps. Browser checks validate local rendered behavior, not model inference or business outcomes.

Screenshots and machine-readable results: `/tmp/shiba-company-evidence/`, `/tmp/shiba-docs-evidence/`, `/tmp/shiba-api-evidence/`. Verification logs use `/tmp/shiba-company-*` and `/tmp/shiba-plain-*`.

Local previews: `http://127.0.0.1:4399/` and `http://127.0.0.1:4399/docs/overview/`. No commit, push, or deployment was performed.
