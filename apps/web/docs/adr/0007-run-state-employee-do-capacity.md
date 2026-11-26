# 0007 — Run state in the employee DO; a global CapacityDO for containers

## Context

Run state, steps, command receipts, PR bindings and review rounds all live in
`OrchestratorState` today (see ADR-0006). The container budget is
deployment-wide: container size and caps live in `vars.INSTANCE_TYPE` plus
the alchemy `Container` (`apps/backend/wrangler.jsonc`, `alchemy.run.ts`;
wrangler rejects `max_instances` on DO-managed containers). `packages/sandbox`
— the registry, contract suite and
four adapters (cloudflare, computesdk, docker-local, e2b) — is the product's
security boundary and must not change; capacity control goes *around* it.

## Options

- **(a) Workflows for runs** — loses: Cloudflare-only, and the approval wait
  becomes an expensive suspended workflow.
- **(b) DO tables plus alarms** — chosen: portable through a workerd self-host
  profile (ADR-0017) and keeps the approval wait cheap.
- **(c) A D1 job table** — loses: run state is hot per-entity state, which per
  ADR-0003 belongs in DO SQLite.

## Decision

(b). Runs and `run_steps` live in the employee DO's SQLite with a D1 `runs`
summary projection (status, timings, cost, `parent_run_id`). A new
`CapacityDO("global")` is the one justified remaining singleton: the resource
it guards — the deployment-wide container budget — is global. Its state is
tiny (`leases(run_id, workspace_id, acquired_at, heartbeat_at)`): `acquire`
succeeds only below the cap, which consolidates into one `SHIBA_MAX_CONTAINERS`
value (default 5) that both alchemy and the CapacityDO read — waiters are
admitted round-robin by
workspace, an unadmitted run becomes `run.queued` with a visible position, and
a lease expires after 3 missed heartbeats (90s) so the `capacity.reap` job can
end the container through the Sandbox adapter. The same class runs on workerd
(ADR-0017).

## Consequences

- We own the step runner — mitigated by keeping `AutomationRunWorkflow`-style
  steps as plain async functions with explicit checkpoints.
- One contract test is added: an adapter `destroy()` must be idempotent,
  because the reaper may call it twice.
- Reversal cost: medium.
