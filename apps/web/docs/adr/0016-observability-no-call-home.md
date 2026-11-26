# 0016 — Structured logs, traces per run, cost per run; no call home

## Context

`apps/backend/src` has ~160 `console.*` calls producing unstructured logs
(158 measured at the baseline; the count drifts as migration work lands);
`redactSecrets` (`apps/backend/src/security.ts`, re-exported from
`@shiba/shared`) is applied ad hoc. Audit lives in `audit_log`
(`apps/backend/migrations/0001_audit_log.sql`) plus `apps/backend/src/audit.ts`
and `apps/backend/src/audit-routes.ts`, pruned inline from the cron. There is no per-run trace and
no per-run cost accounting. Buyers are self-hosters: observability must not
phone home.

## Options

- **A hosted observability service** — loses: customer data leaves the
  deployment; unacceptable for a self-hosted approval-gated agent.
- **Structured local logs + opt-in OTLP export** — chosen.

## Decision

`apps/backend/src/obs/log.ts` (planned) emits JSON lines
`{level, msg, ts, stage, workspaceId, threadId, runId, approvalId, traceId}`
with context carried through `AsyncLocalStorage` (works in Workers with
`nodejs_compat`); Biome `noConsole` becomes an error with an `obs/` allowlist.
Each run has a `traceId`; run steps log `span.start`/`span.end` records that
Workers Logs and Observability ingest as-is. A buyer can set
`SHIBA_OTLP_ENDPOINT` to export to their own collector — the portable path.
There is no call home and no default exporter. Audit moves to an append-only
D1 `audit_events` table recording every approval transition, credential use
(the kid, never the value), outbound connector write, PR publish and role
change, pruned by the `audit.prune` job (default 400 days). Cost per run comes
from `run_usage` rows written at each model call and container release, with
`price_version` pointing at `packages/shared/src/pricing.ts` (planned,
versioned in the repo so old totals don't change when prices do); the thread
shows cost on `run.completed`, and subscription calls record tokens with
`cost_micros = 0` and `billing = "subscription"`.

## Consequences

- Reversal cost: low — logs and audit rows are additive.
