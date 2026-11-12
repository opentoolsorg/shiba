# Deeper AI employee documentation — 2026-11-07

## Scope and source

This content-only follow-up starts from draft PR #202 at `fda04b9e4175d5466ca362b5707a320e37584dfd`. It preserves the approachable AI employee introduction and existing routes, adding practical detail where people need to use the product. The latest inspected main is `c3cdb05e`; this isolated content commit does not itself integrate that branch or the separate marketing-header change.

No application behavior, authentication policy, permission, feature flag, dependency, or deployment changed.

- Add **Files and revisions**: named deliverables versus ZIP output, exact size/format limits, capture checks versus content quality, saved review versus revision approval, logical-task version history, and signed-link sharing/expiry.
- Add **Context and memory**: owner-private source library, supported uploads, provenance-only URLs, keyword recall, project selection/defaults, bounded frozen excerpts, correction, retention, deletion and pending cleanup.
- Add **Permissions and roles**: deployment operator, workspace admin, room participant, employee profile, and MCP identity; account, capability, resource and action checks.
- Expand connections and team guides; distinguish supported, default-off and review-only team features.
- Document automation Disable/Enable, schedule-only artifact targets, unsupported connected-app automation targets, live employee-pin checks versus stored skill snapshots, and pre-approval condition-service usage.
- Correct standard ChatGPT SIWC credential custody: placeholder in the sandbox, real tokens/refresh in the Worker. Remove the sandbox OAuth fallback recommendation; qualify device-auth as a separate, default-off, deployment-dependent path.
- Correct built-in authentication/enrollment, obsolete unattended approval claims, runtime concurrency and reported-cost limits, capture bytes and partial-tree refusal, Cursor namespace and removed Devin configuration.
- Connect the new guides from the sidebar, first-task flow, overview, related guides and machine-readable introduction.

## Source map

| Topic | Main implementation inspected |
| --- | --- |
| Deliverables and review | `RunDeliverables.tsx`, `run-deliverables.ts`, `artifact-metadata.ts`, `artifact-download.ts`, `packages/shared/src/deliverables.ts` |
| Source library and projects | `MemorySourcesView.tsx`, `MemoryPanel.tsx`, `owner-memory-store.ts`, `owner-memory-ingestion.ts`, `memory-routes.ts`, task composer |
| Roles and tool policy | `request-auth.ts`, `team-member-auth.ts`, `employee-tool-policy.ts`, `packages/auth/src/better-auth.ts` |
| Automations | `AutomationsView.tsx`, `automations.ts`, `automation-runner.ts`, `automations-do.ts` |
| Model authentication | `harness/codex-subscription.ts`, `harness/codex-device-auth.ts`, `subscription-auth-routes.ts`, `egress.ts`, harness registry |
| Runtime and budgets | `runtime.ts`, `pr-publish-approval.ts`, `packages/shared/src/container-budget.ts`, orchestrator, Wrangler and Alchemy configuration |
| Optional team boundaries | `docs/personal-team-execution-contract.md`, `docs/team-model-sessions.md`, `docs/shared-computers.md`, `docs/team-employee-coordination.md` and corresponding configuration |

Independent source review found one substantive wording problem: skill pins are checked against their saved enabled/hash values, not re-resolved against the original library at dispatch. The final text separates this from current employee-profile resolution and tells users to update the automation's saved instructions explicitly. No additional actionable issues were found in the three new guides.

## Validation

- Web tests: **17 passed**, including five additional documentation regression tests.
- Focused backend contracts: **215 passed across 11 files** covering artifact metadata/download/access, named deliverables, source ingestion/store, employee tool policy, automations, SIWC credentials, security tradeoffs and budgets.
- Focused frontend workflows: **70 passed across four files** (`RunDeliverables`, `MemorySourcesView`, `AutomationsView`, `TaskComposer`). Fixtures emitted localhost:3000 connection-refused diagnostics; no real service acceptance is inferred.
- Capture-security/workspace artifact and built marketing/SEO checks: **52 passed across four files**.
- Astro diagnostics: **173 files**, zero errors, warnings or hints. Existing OpenAPI metadata and optional-partials notices remain outside the diagnostics result.
- Production build: **six tasks successful** (five cache hits), including the unchanged dashboard output and rebuilt documentation. Static assembly and route verification passed.
- Built output: **99 HTML pages and 7,786 local links/assets/anchors** verified, with **59 Markdown sources** checked for stale claims; generated agent Markdown, API pages and search remain present.
- Package typechecks/import lint: **18 tasks successful** (17 cache hits). Root TypeScript build and SDK generated-type consistency passed.
- Focused Biome using the repository's formatter/assist-disabled check mode: **three files passed**. Root Biome CI exits successfully with existing warnings; Knip exits successfully with its existing report. No automatic formatting or unrelated fixes were applied.
- `git diff --check` passed.

## Limits

The complete aggregate suite was not rerun: the earlier refresh records unchanged backend failures and a blocked live TypeSafe continuation. These focused checks do not replace a green full gate. No live model, provider consent, vendor action, browser visual acceptance, merge, or deployment was tested or performed. This pass validates source-described workflows, not every provider's current commercial terms or production configuration.

Integration onto newer main or with the separate header change requires checking the combined result. The content commit intentionally leaves that coordination separate.
