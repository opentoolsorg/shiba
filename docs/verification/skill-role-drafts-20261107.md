# Role-based draft skill catalog verification

Date: November 7, 2026. Base: `b8e2dec5015c005a288284094dce83f26954c078`.

## Change

Six independently written workflows extend the general skill library from 11 to
17 templates: marketing campaign brief, sales account brief, product
specification draft, design review notes, operations runbook draft and QA test
plan. Engineering and general research workflows already exist in the library.
These additions provide focused reusable instructions, not new employee roles,
provider adapters or automatic role-to-skill installation.

Each new template uses supplied or explicitly granted sources, treats retrieved
content as untrusted evidence, identifies unsupported claims and returns a draft
for human review. Instructions preserve exact-action approval, account/resource
boundaries and the separation between a plan and verified execution. Installation
uses the unchanged owner-scoped draft/review/activate path. No credentials,
connections, permissions, schedules or runtime execution paths were added.

## Checks

- **124 tests passed across 10 backend test files**, including 18 new
  parameterized cases. The run covers catalog schema and unique seed parity,
  all six new skills' owner isolation and idempotent installation, review before
  activation, refusal to use draft/review/disabled pins, and refusal to install
  with read-only API tokens. Existing team-skill, orchestrator, MCP prompt and
  repository security contracts also pass.
- The same run includes **two built marketing-page tests** after the Astro
  production build. The generated integrations page contains all 17 template
  names and the live catalog count while retaining its connection and publishing
  disclaimers. This is built HTML verification, not interactive browser QA.
- Backend source and test TypeScript checks passed.
- Astro production build passed. Astro check inspected 170 files with zero
  errors, warnings or hints. Build logs retain existing OpenAPI/content and
  bundler notices; this change does not alter those inputs.
- Changed-source ESLint and focused Biome checks passed. Biome reported nine
  warnings on unchanged lines of the existing route test.
- `git diff --check` passed.

Commands, run from the repository root unless a directory is shown:

```sh
cd apps/backend
./node_modules/.bin/vitest run \
  test/skill-library.test.ts test/skill-library-routes.test.ts \
  test/skill-library-install.test.ts test/skills-routes.test.ts \
  test/team-skill-token-scope.test.ts test/team-skills-onboarding.test.ts \
  test/orchestrator-managed-skills.test.ts test/mcp-skill-prompts.test.ts \
  test/tradeoff-contracts.test.ts test/marketing-pages.test.ts
cd ../..
./node_modules/.bin/tsc -b apps/backend
./node_modules/.bin/tsc --noEmit -p apps/backend/tsconfig.test.json
./node_modules/.bin/eslint apps/backend/src/skill-library/index.ts
./node_modules/.bin/biome check --formatter-enabled=false --assist-enabled=false \
  apps/backend/src/skill-library/index.ts \
  apps/backend/test/skill-library.test.ts \
  apps/backend/test/skill-library-routes.test.ts
cd apps/web
ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro build
ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro check
```

The build must precede the built marketing tests. The first local build attempt
stopped at Astro's default telemetry configuration directory; disabling optional
telemetry allowed the isolated build without modifying the home directory.

These offline checks do not establish live provider compatibility, connected
accounts or the factual quality of future generated drafts. No live actions,
production migrations, deployment or full monorepo test suite were run for this
catalog-only change.
