# 0010 — Memory: source of truth in DO SQLite; Vectorize is derived

## Context

`apps/backend/src/memory-do.ts` already runs Memory DO instances per agent
name (`env.Memory.idFromName(agent)`) plus a `"global"` registry
(`MEMORY_REGISTRY_NAME`), and recall goes through the `MEMORY_VECTORS`
Vectorize index (768-dim cosine, `agent` metadata index, in
`apps/backend/wrangler.jsonc`). Vectorize cannot do transactions or exact
deletes with read-after-write, and it is Cloudflare-only. The target model adds
scopes — `workspace`, `employee`, `user` — each item carrying `owner_id` and
`source`.

## Options

- **Vectorize as the source of truth** — loses: no transactions, no exact
  deletes, no read-after-write, and no portable fallback.
- **DO SQLite as source, Vectorize as a derived index** — chosen.

## Decision

The Memory DO for each workspace is the source of truth: items carry text,
scope, owner, source, TTL and `deleted_at` in DO SQLite. Vectorize is a
derived index with metadata filters `{ws, scope, owner}`; every query filters
on `ws`, and on `owner` for the user scope (deny-by-default applies here too).
A soft delete sets `deleted_at` and removes the vector at once; a hard purge
comes 30 days later through the `memory.retention` job, and deleting a member
purges that user's scoped items immediately. `memory.reindex` rebuilds
Vectorize from DO SQLite when the embedding model changes or for disaster
recovery. Portable fallback: brute-force cosine scan in DO SQLite (fine to
roughly 50k items per workspace) or `sqlite-vec` on a server.

## Consequences

- A write goes to two stores and the index is eventually consistent —
  acceptable because the index is rebuildable.
- Reversal cost: low.
