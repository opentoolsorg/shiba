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

`0061_runtime_d1_schema.sql` captures the former request-time schema, with
`IF NOT EXISTS` so databases already initialized by older Workers retain data.
Missing additive columns are installed by migrations rather than repaired on reads.

Run `node apps/backend/scripts/check-migrations.mjs` to check filename ordering,
the exact legacy exception, and runtime D1 DDL. Root `pnpm test` runs this check.
The fresh D1 migration test applies the complete history under Miniflare and
checks tables referenced by D1 application SQL.
