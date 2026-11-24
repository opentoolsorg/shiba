# 0017 — Portability profile

## Context

The plan is "Cloudflare first, any server second". Durable Objects, Queues,
Workflows, Vectorize and Containers are all Cloudflare services; whether D1
and Queues run acceptably on workerd is unverified (open question Q2 — "any
server" is not a launch promise). The sandbox adapters in `packages/sandbox`
(cloudflare, computesdk, docker-local, e2b) already abstract the container
runtime, and `apps/backend/src/platform/{queues,workflows}.ts` already
concentrate the queue and workflow bindings.

## Options

- **Bet on Cloudflare-only bindings everywhere** — loses: every binding becomes
  an unrecoverable dependency for self-hosters who outgrow or leave Cloudflare.
- **A defined portability profile with in-repo fallbacks** — chosen.

## Decision

The portable target is **workerd** (which runs DOs with on-disk SQLite), with
these substitutions: the Docker sandbox adapter in place of Containers, SQLite
in place of D1, a DB-backed job table in place of Queues, DO alarms in place of
Workflows, SQLite cosine search in place of Vectorize, and the filesystem or
S3 in place of R2. The standing rule: every new Cloudflare-only binding has to
sit behind a small interface with one in-repo fallback — the same pattern
`packages/sandbox` already uses for adapters and
`apps/backend/src/platform/queues.ts` uses for queue dispatch. Nothing ships on
this profile before a spike: a ~2-day workerd + SQLite + Docker-adapter run of
the Slack→PR path (scheduled after the thread-model work) establishes whether
D1 and Queues semantics hold.

## Consequences

- The rule constrains binding choices going forward; fallbacks are written
  once, in-repo, not per deployment.
- Reversal cost: n/a — this ADR adds a constraint, not a migration.
