# Repository guidance

Read this file before editing Shiba. Then read the nearest `AGENTS.md` for the
directory you are changing. Nested guides add local rules; they do not replace
the non-negotiable rules here.

## Working style

Be concise. Keep going when the next step does not need the developer. Stop and
ask only when blocked, before destructive actions, or before changing anything
outside the repository.

For work with more than a few steps, keep a checklist where the developer can
see it. For an audit or migration that divides into independent areas, give each
area focused attention and check the evidence before accepting the result. Mark
claims you could not confirm and say where you looked.

The rules under **Non-negotiable** protect users, credentials, released
contracts, and the approval boundary. Change them only on an explicit developer
decision. Other rules are defaults: follow the developer's preference and say
which default you set aside.

## Use the right context

Use the smallest current document that answers the question:

1. `docs/product/ai-employees.md` is the product contract.
2. `ARCHITECTURE.md` is the living architecture map.
3. `docs/architecture/` holds topic notes. Read the note for the area you are
   changing, not the whole directory.
4. `design.md` is the visual system for dashboard, docs, and marketing work.
   It follows the Google `DESIGN.md` format: machine-readable YAML tokens plus
   prose that explains how to apply them.
5. `docs/SOURCE-LAYOUT.md` maps backend domain ownership. Update it when a
   backend source file moves or a new one appears.

`PLAN.md`, `ROADMAP.md`, `VERIFICATION.md`, `VERIFICATION_PLAN.md`, and files
under `docs/verification/` are dated planning or evidence records. Open them
only when a task id, acceptance question, or historical claim requires them,
and read the matching section instead of loading the whole file. They are not
the current architecture. `docs/audits/` contains point-in-time review records;
do not treat audit findings as current until you verify them against the code.

Keep durable knowledge in the canonical document that owns it. Do not add prompt
transcripts, agent session logs, temporary design exports, or one-off review
scratch files as repository context.

## Living docs ownership

Read the owning document before work in a new area, and update it in the same
commit as the behavior change. Keep entries short: decisions, contracts, and
reasons, not narratives. If a doc becomes stale, fix it when you notice.

| Document | Owns |
| --- | --- |
| `docs/product/ai-employees.md` | Product contract, employee/workspace goals, acceptance boundaries |
| `ARCHITECTURE.md` | Architecture roles, spine, and topic index |
| `docs/architecture/` | Security, lifecycle, browser, computer use, harness, and change rules |
| `design.md` | Machine-readable visual system, design tokens, and application rules |
| `docs/SOURCE-LAYOUT.md` | Backend source-file domain ownership |
| `CONTRIBUTING.md` | Validation labels, contributor gate, and QA handoff |
| `docs/DEPLOY.md` | Deployment, bindings, secrets, and preview operations |
| `README.md` | Public quickstart, repository shape, and honest status |
| `apps/web/src/content/docs/` | Public operator and product documentation |

When you add a durable living document, add its ownership row here. Point-in-time
plans, audits, and evidence do not belong in this table.

## Non-negotiable

A change that breaks one of these rules is wrong even if existing tests pass.

### Credentials never enter the container

Model and subscription tokens are attached in the Worker egress proxy. The
sandbox sees a placeholder (`shiba-egress-placeholder` or the harness dummy
key), never the real bearer, refresh token, or `auth.json`.

Locked by `apps/backend/test/tradeoff-contracts.test.ts` and
`apps/backend/test/codex-subscription.test.ts`.

### Subscription lanes do not need AI_GATEWAY_TOKEN

A connected ChatGPT plan (`codex-subscription`) and an opted-in Claude
setup-token (`claude-subscription`) run without `AI_GATEWAY_TOKEN`. A paired
local daemon running Claude Code also does not need it. Gemini, Grok, and
OpenCode still use the gateway.

Locked by `apps/backend/test/setup-doctor.test.ts` and
`apps/backend/test/acp-providers.test.ts`.

### Approval is required before any sandbox starts

Queueing a task mints an approval. The harness does not run, and no sandbox is
created, until that approval is granted.

Locked by `apps/backend/test/phase1-core-loop.integration.test.ts`.

### The GitHub token is scoped to the approved repo

Until a run is approved for one repository path, GitHub egress is denied. After
approval, requests outside that path are refused. The token is not a general
GitHub credential for repository code.

Locked by `apps/backend/test/tradeoff-contracts.test.ts`.

## Working agreement

- Make the smallest change that preserves the product contract.
- Put browser-safe wire contracts in `packages/shared` only when they cross a
  package boundary.
- Update the canonical docs affected by behavior you change. Do not update a
  historical plan or audit to describe new behavior.
- Keep validation risk-proportionate: run the narrowest useful local checks,
  leave broad lanes to CI, and state what remains unverified. Use the full local
  gate for cross-cutting runtime, deployment, credential, approval, or release
  work, not for every docs or test-only edit.
- Name the surfaces a behavior change touches and check the affected consumers
  and reverse actions where they exist: approve/reject, connect/disconnect,
  pause/resume, publish/unpublish, or their closest equivalents.
- Shiba CI is label-gated. Use `build:validate` for core validation, add
  `verify:shiba` only for browser-validation work, and use `ci:deferred` only
  when browser validation is intentionally deferred. Never make expensive lanes
  run automatically on every PR.
- Before marking a PR ready, leave a QA handoff on the PR: exact tested head
  SHA, selected labels and lanes, commands or flows exercised, evidence, and
  limitations. New commits supersede earlier QA. Docs-only, test-only, and CI
  metadata changes may state why browser QA was not needed. Never include
  credentials, private bypass links, or cookies.

## UI polish

For Shiba web, docs, or dashboard visual-polish requests, read
`.agents/skills/shiba-ui-polish/SKILL.md` and apply its guidance alongside the
relevant framework skill. Keep the requested scope and existing product
contracts.
