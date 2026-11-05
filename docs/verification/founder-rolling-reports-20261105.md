# Reviewed rolling-period reconciliation — 2026-11-05

Base: PR188 `7a96effab47d56820ae24f2c869d7d70eb1709f2`.
Delivery branch: `feat/prince-multi-agent-control-plane--rolling-reports`.
This is fixture/local acceptance, not live end-to-end provider acceptance.

## Implemented contract

- Explicitly reviewed native private rolling view over an existing completed,
  authorized capture; no provider/model fetch during composition.
- Select a 1–28 fixed-day UTC invoice-created interval and metric. Half-open
  boundaries never become local-calendar or payment-date accounting.
- Exact integer-string per-currency matched totals. Duplicates and undated rows
  remain unassigned. Missing, partial, non-comparable and independently timed
  evidence remains visible with capture ages, skew and status counts.
- Report/receipt/executor/source/mapping/review provenance is retained. Current
  owner, tenant, native membership/session and source proofs remain mandatory,
  including the final proof after a previously successful read.
- MRR and churn are unavailable, with no metric totals and precise missing
  subscription lifecycle/cohort/definition-contract reasons. Invoice sums are
  never relabeled as those metrics.
- No automatic refresh/retry, future consent, sandbox execution or Slack sharing.
  Standing consent and Slack families are not widened.

## Focused backend acceptance

- `pnpm -C apps/backend exec vitest run test/founder-reconciliation-rolling.test.ts`
  — 28 passed.
- `pnpm -C apps/backend exec vitest run test/founder-reconciliation-routes.test.ts test/founder-reconciliation-store.test.ts`
  — 10 passed (run together with rolling and compute checks).
- `pnpm -C apps/backend exec vitest run test/founder-reconciliation-compute.test.ts test/founder-reconciliation-rolling-routes.test.ts`
  — 22 passed after regeneration of the required source pins.
- `pnpm -C apps/backend typecheck` — passed after frozen-lockfile install aligned
  dependencies with the fetched branch. No lockfile changes.
- Scoped backend ESLint, `git diff --check`, reconciliation manifest checks — passed.
- Independent read-only backend security review found no concrete defects.

The first compute pin check correctly failed after the production edit. Only
`founder-reconciliation-generated.ts` and its direct dependent
`founder-reconciliation-schedule-generated.ts` were regenerated. Integrators must
rerun both generators after combining any overlapping source changes. Existing
old executor/standing-grant pins fail closed and require fresh human review;
no automatic migration of consent is intended. No Slack renderer pin changed.

## Limits and coordination

Captures are bounded snapshots, not complete ledgers or historical point-in-time
payment records. Capture ages reflect evaluation time; rows/totals and selected
source provenance are reproducible, not necessarily byte-identical age fields.
Provider-side revocation since capture cannot be proven by local grant checks.
MRR/churn need a separate reviewed lifecycle-input and metric-definition contract.

Only the dedicated branch is published; no competing PR, shared PR188 branch
push, main merge, deployment or managed-preview resume is authorized. The current
thread tool surface does not expose `other_thread_control send_message`, so the
requested direct handoff to parent `thr_54fca85da69a4da4b7031ff85cbdb5b1` is unavailable. This durable
report and the final branch/commit links are the handoff evidence.
