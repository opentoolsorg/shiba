# Bugbot review rules (shiba)

Cursor Bugbot and automated reviewers: treat this as binding for PRs on `cursor/phase1-consolidated-c137` and follow-on merges to `main`.

## Hard rules

1. **No deploys** — CI, agents, and Bugbot must not run production deploys (`wrangler deploy`, Alchemy apply, container publish). Allowed: documented dry-run checks only (e.g. `check:deploy`, wrangler `--dry-run` where the repo already gates it).
2. **No secrets in logs or git** — Never commit, print, or comment tokens, API keys, `.env` values, or webhook signing material. Scrubbers and redaction paths must stay on for outbound GitHub/MCP traffic.
3. **Sandbox boundary** — No direct Cloudflare Sandbox/container SDK calls outside `packages/sandbox`’s **cloudflare adapter** (and the backend’s thin `SandboxOps` wrapper). Worker code routes all exec/preview/session through that adapter.
4. **Typed boundaries** — HTTP handlers, webhooks, and DO RPC must validate input/output with the project’s typed schemas (Zod/contract types in `packages/shared`, route modules). Reject unknown fields where the contract says so; do not pass `unknown` into persistence.
5. **DO idempotency** — Review rounds, webhook delivery, PR-owner index updates, and den/subagent tree mutations must be safe under retries and concurrent requests (dedupe keys, monotonic versions, or “already applied” no-ops). Double webhook posts or double review rounds are defects.
6. **D1 migrations** — Append-only, ordered, backward-compatible for one release. No destructive reordering, no editing applied migration files; add a new migration instead.
7. **Captain / crew aliases** — Preserve `captain`/`crew` naming and `SWARM_MODES` / `modeForRole` mapping in `spec/CONTRACTS.md`. Do not rename to orchestrator-only strings in user-facing APIs without an explicit migration.
8. **Tests prove behavior** — New logic needs tests that assert outcomes (status codes, persisted state, idempotent second call), not only that mocks were invoked.

## Focus areas (large / infra PRs)

- Token handling, SIWC/OAuth, scrubber coverage, webhook HMAC/auth
- DO concurrency: review lifecycle, PR owner index, subagent tree
- D1 migration order and rollback story
- Sandbox SDK 1.0 / adapter one-way doors
- `wrangler.jsonc` vs `alchemy.run.ts` drift (`check:deploy`)

## Required gates (must stay green before merge)

```bash
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built && pnpm check:ci && pnpm check:deploy
```

Local secret hygiene (not always in CI): `pnpm env:load && pnpm env:scan`.
