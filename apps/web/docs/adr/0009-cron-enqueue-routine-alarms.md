# 0009 — Cron enqueues only; routines run on per-workspace alarms

## Context

`scheduled()` in `apps/backend/src/index.ts` runs its jobs serially through
`ctx.waitUntil`: founder Stripe/Meta/HubSpot reads, reconciliation and
automatic-read ticks, Slack coworker ticks, the automations tick
(`internal/tick` on the `Automations` DO), the stale-draft sweep and the audit
prune. A slow HubSpot read can delay Slack ticks. `Automations` is a singleton
(`AUTOMATIONS_DO_NAME = "default"` in
`apps/backend/src/automation-runner.ts`); `AutomationRunWorkflow` exists in
`apps/backend/src/platform/workflows.ts`. Queues `shiba-ingest`,
`shiba-webhooks` and `shiba-email` already exist with DLQs
(`apps/backend/wrangler.jsonc`).

## Options

- **(a) Keep serial cron** — loses: one slow job delays all the others.
- **(b) One Workflow per job** — loses: Workflows is Cloudflare-only and
  heavier than the jobs need.
- **(c) A queue fan-out for system jobs plus DO alarms for routines** —
  chosen.

## Decision

(c). `scheduled()` stops running jobs; it enqueues one `shiba-jobs` message per
job with `idemKey = job:{name}:{windowStart}`, and the consumer runs each job
on its own with retries, the DLQ and per-job timeouts (a new `shiba-outbox`
queue serves surface delivery, ADR-0004). Routines are user-defined and
per-workspace: definitions live in D1 `routines`; the workspace's `Automations`
DO is re-keyed from the singleton to `workspaceId` and keeps one alarm set to
the next fire time; when it fires, the DO appends `rtn:{id}:{scheduledAt}` to
the routine's thread (every routine has a home thread, output lands through
bindings) and starts `AutomationRunWorkflow`. A `routines.reconcile` cron job
re-arms any lost alarm. Each routine carries `max_runs_per_day`,
`max_cost_micros_per_day` and `max_container_minutes`, checked before start
against `run_usage`; exceeding the budget pauses the routine and emits a thread
event — never a silent failure. Routines never retry consequential actions
automatically; those need a new approval.

## Consequences

- Two mechanisms, but each fits its job: system jobs are fixed and global,
  routines are user-defined and per workspace.
- Reversal cost: low.
