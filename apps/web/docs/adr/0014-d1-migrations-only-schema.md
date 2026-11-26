# 0014 — D1 migrations are the only schema source; never renumber

## Context

`apps/backend/migrations/` holds 59 migrations with head `0060_palette_search.sql`.
Two files share the `0036` prefix (`0036_slack_coworker_private_status.sql` and
`0036_team_work_tasks.sql`): D1 tracks applied migrations by file name, so
renumbering one would re-apply it on prod — both stay, with a CI allowlist.
Meanwhile 33 source files run `CREATE TABLE IF NOT EXISTS` against
`AGENT_AUDIT` at runtime (47 files have the pattern overall, including DO
SQLite DDL, which is legitimate), so prod's schema is whatever code happened
to run first.

## Options

- **Keep runtime DDL alongside migrations** — loses: two schema sources means
  drift is discovered in prod, not in review.
- **Consolidate into migrations only, with CI guards** — chosen.

## Decision

D1 migrations under `apps/backend/migrations/` are the only schema source.
Runtime DDL is consolidated into new migrations whose DDL is copied from prod's
`sqlite_master` — a read-only query — never from the code, so prod's actual
shape wins and drift is fixed on purpose by a follow-up migration. CI guards:
unique migration prefixes (the `0036` pair allowlisted), no new
`CREATE TABLE` against `AGENT_AUDIT` outside `migrations/` with a shrinking
allowlist, and a schema snapshot diff on every PR that touches `migrations/`.
Durable Object state is versioned separately: each DO keeps a `schema_version`
in its own SQLite and migrates in `blockConcurrencyWhile` on first access,
with tests upgrading from fixtures of every prior version. Migration numbers
`0061`+ assume `0060` is the head; the real head is re-confirmed before any
migration PR is numbered.

## Consequences

- Reversal cost: n/a — every step is additive (`IF NOT EXISTS`, `ADD COLUMN`
  with constant defaults); old data is never deleted in the release that stops
  writing it.
