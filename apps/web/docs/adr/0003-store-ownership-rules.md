# 0003 — Store ownership rules

## Context

State today is spread across D1 (`AGENT_AUDIT`, `apps/backend/migrations/`),
Durable Object SQLite, three R2 buckets (`ATTACHMENTS`, `ARTIFACTS`, `FILES` in
`apps/backend/wrangler.jsonc`), Vectorize (`MEMORY_VECTORS`), and KV
(`AGENT_TOKENS`). Every entity needs one named owner for its source of truth,
or the same fact ends up authoritative in two places.

## Options

- **(a) D1 for everything** — loses: DOs are the only authoritative state today,
  and ordered high-write logs do not belong in a replicated SQL database.
- **(b) DO SQLite for everything** — loses: anything listed or queried across a
  workspace, and anything that must outlive a DO being re-keyed, needs D1.
- **(c) The split rule** — chosen.

## Decision

(c), as fixed in the proposal's domain model
(`docs/proposals/target-architecture-2026-11.md` §4):

- **D1** owns anything listed or queried across a workspace, and anything that
  must outlive a DO being re-keyed (directory, approvals, projections, audit).
- **DO SQLite** owns ordered, high-write logs and hot per-entity state (thread
  events, runs, memory items, routine alarms).
- **R2** owns blobs; **Vectorize** owns nothing — it is a derived index and can
  always be rebuilt; **KV** holds only write-once data with a TTL (OAuth state,
  short-lived token caches).

## Consequences

- Projections can lag the DOs. Each projection carries `last_seq`, so its
  writes are idempotent and can be repaired.
- Reversal cost: medium per entity — moving one entity's source of truth is a
  migration, not a config change.
