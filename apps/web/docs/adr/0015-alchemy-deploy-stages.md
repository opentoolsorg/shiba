# 0015 — One deploy path through alchemy stages

## Context

Deploy paths today: `alchemy.run.ts` (primary), `apps/backend/wrangler.jsonc`
(rollback/binding source), `apps/backend/wrangler.dogfood.jsonc`,
`apps/backend/wrangler.noroutes.tmp.jsonc`, the workflows under
`.github/workflows/` (`deploy.yml`, `deploy-worker.yml`, `preview-deploy.yml`)
and `scripts/deploy-preview*.mjs`. `preview-deploy.yml` hardcodes PR 188
(lines 20, 43, 62). Alchemy is pinned at `2.0.0-beta.80` — a beta on the deploy
critical path. Prod, dogfood and PR previews should deploy the same way.

## Options

- **(a) Wrangler for everything** — loses: four divergent configs already
  exist and previews are bolted on.
- **(b) Alchemy for everything** — chosen, with a pinned version and a
  documented wrangler escape hatch for prod.
- **(c) Keep four paths** — loses: the status quo is the problem.

## Decision

(b). `alchemy.run.ts --stage prod|dogfood|pr-<N>`; a stage maps to a Worker
name, D1, routes, secrets source and container cap. The dogfood and
noroutes-tmp wrangler configs are deleted; `wrangler.jsonc` stays only as
alchemy's binding source if needed, otherwise it is generated. The prod
`wrangler deploy` fallback stays documented until alchemy reaches 2.0 GA, and
prod deploys are gated on a same-CI dogfood deploy. Previews take the PR number
from `github.event.pull_request.number` (the hardcoded 188 is removed), each
gets its own D1 seeded from fixtures — never prod — its own Slack dev app or a
disabled Slack surface, a container cap of 1, and teardown on PR close.

## Consequences

- A beta dependency sits on the deploy critical path — mitigated by pinning and
  the documented fallback.
- Reversal cost: medium — the stage config would have to be regenerated as
  wrangler files.
