# 0006 — Split the orchestrator into an employee agent per (workspace, employee)

## Context

`apps/backend/src/agents/orchestrator.ts` is 7,458 LOC — the `CodingOrchestrator`
class (`Think<Env, OrchestratorState>`) holds planning, approvals,
`commandReceipts`, employee drafts, Slack canvas maps, GitHub PR bindings and
review rounds in one `OrchestratorState` JSON blob (interface at line 278).
Capped lists (`slice(-300)` at lines 898 and 955) silently drop runs and
approvals — data loss dressed up as a cap. The DO is addressed through the
`"default"` singleton: `ORCHESTRATOR_NAME = "default"` is hardcoded in
`apps/backend/src/slack-routes.ts`, `apps/backend/src/mcp-screen-tools.ts`,
`apps/backend/src/mcp-run-tools.ts` and `apps/backend/src/email-approvals.ts`,
resolved via `getAgentByName` from the `agents`
package. Other callers address instances by user id, agent name or chat thread
key, so there are many live instances, not one.

## Options

- **(a) Keep the singleton, move state into tables only** — leaves the 7.5k-LOC
  class and the singleton routing in place.
- **(b) A DO per run** — loses: runs of one employee share planning context and
  working memory; per-run DOs duplicate that state.
- **(c) A DO per employee, runs as tables inside it** — the target shape.
- **(d) (a) first, then (c)** — chosen: two moves, done in order, never at once.

## Decision

(d). Keep the class name `CodingOrchestrator` (DO class names are not renamed —
see ADR-0004). Move-only extraction into `apps/backend/src/agents/employee/`
(planned): planner, a pure run state machine, repo, approvals (moved to the
top-level service, ADR-0008), Slack canvas, GitHub PR bindings and review
rounds, container reaper, receipts, employee drafts. Then: (1) blob → DO SQLite
tables inside the same `"default"` instance, dual-read table-first; (2) re-key
to `${workspaceId}:${employeeId}` — new runs start on new instances, `"default"`
drains (each run row records its `agentInstance`), then stays read-only for one
release and is never deleted.

## Consequences

- One employee serializes its own planning — acceptable, since the slow parts
  are model calls and containers. A run is pinned to the instance it started
  on.
- Reversal cost: low after step 1, medium after re-keying (route by
  `agentInstance`).
