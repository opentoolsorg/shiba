# D1 migrations

`apps/backend/migrations` is the only schema source for `AGENT_AUDIT`.
Apply all pending migrations before starting a Worker, including a preview:

```sh
pnpm -C apps/backend exec wrangler d1 migrations apply AGENT_AUDIT --local
# For an explicitly selected remote environment, use --remote and its --env.
```

Request handlers assume the schema is installed. Durable Object local SQLite
belongs to each object's lifecycle and is independent of these D1 migrations.

Migrations are append-only. Never rename or edit an applied migration: D1 records
filenames, and existing databases must keep their history. In particular, both
`0036_slack_coworker_private_status.sql` and `0036_team_work_tasks.sql` have already
been applied. They remain the sole duplicate-prefix exception. Historical gaps
before 0060 remain unchanged too. From 0061 onward numbers must be contiguous;
check open PRs before reserving the next number.

`0061_note_chat.sql` and `0062_media_generations.sql` retain their main-branch
identities. The architecture migrations follow as `0063_runtime_d1_schema.sql`,
`0064_thread_queue.sql`, and `0065_scheduled_job_slots.sql`, in that order.

Main also shipped `0061_learning_review.sql` (a second 0061) and `0068`/`0069`
before `0066_routine_outcomes.sql` filled 0066. `0062_inbound_webhook_receipts.sql`
and `0063_workspace_channel_facts.sql` were renumbered to 0062/0063 on their own
branches, which a merge had already given to `0062_media_generations.sql` and
`0063_runtime_d1_schema.sql`. All of those names stay as shipped: renaming a
migration a database may already have applied would re-run it. The guard accepts
those four duplicate pairs and the 0067 gap, and nothing else. 0067 stays skipped
and is never filled retroactively.

`0063_runtime_d1_schema.sql` captures the former request-time schema, with
`IF NOT EXISTS` so databases already initialized by older Workers retain data.
Missing additive columns are installed by migrations rather than repaired on reads.

Run `node apps/backend/scripts/check-migrations.mjs` to check filename ordering,
the exact legacy exception, and runtime D1 DDL. Root `pnpm test` runs this check.
The fresh D1 migration test applies the complete history under Miniflare and
checks tables referenced by D1 application SQL.
