# 0002 — Tenancy: one organization per deployment, many workspaces

## Context

`ARCHITECTURE-AS-BUILT.md` §10 records "Single-tenant by contract" as a known
gap. The north star needs teams — a buyer's teammates sharing one deployment —
and `spec/GOAL.md` remains the product contract the decision must fit.

The groundwork already exists: `team_workspaces` and
`team_workspace_memberships` (roles `owner`/`admin`/`member`) are keyed by
`(tenant_id, workspace_id)` in `apps/backend/migrations/0016_report_slack_deliveries.sql`
(re-created idempotently in `0018_slack_installations.sql`), and the
`WorkspaceEvents` Durable Object is already keyed by workspace
(`workspaceEventsName()` in `apps/backend/src/platform/workspace-events-do.ts`).

## Options

- **(a) One workspace per deployment** — loses: the north star needs multiple
  teams per buyer, and every row would still sit in `ws_default`.
- **(b) Hosted multi-tenant SaaS** — loses: the container pool, egress proxy
  and vault key are shared per deployment, which is acceptable between teams of
  one company and not between strangers.
- **(c) One organization per deployment with many workspaces** — chosen.

## Decision

(c). One deployment serves one buyer organization — the security boundary.
Inside it there are 1..n workspaces — the authorization and data-scoping
boundary. Concretely: `workspace_id` on every D1 table holding user data
(`NOT NULL DEFAULT 'ws_default'`, which does not rewrite the table), every DO
holding per-workspace state keyed by workspace, every Vectorize query filtered
on `ws`, and `ws/{id}/` prefixes on new R2 keys (old keys stay valid through a
metadata lookup). There is no hostile-tenant isolation, and the docs say so.

## Consequences

- `ARCHITECTURE-AS-BUILT.md` "single-tenant" wording is redefined as "single
  *organization*"; the data-model changes land through the migration plan
  (`docs/proposals/target-architecture-2026-11.md` §13, step M12+).
- Doing this before launch is cheap; retrofitting after customers have data is
  the expensive kind of migration.
- Reversal cost: low going to (a), since everything just sits in `ws_default`.
  Very high going to (b), which would need isolated pools and per-tenant keys.
  Not planned.
