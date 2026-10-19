# ReviewDO proposal (Phase 4 — design only)

**Status:** proposal — not implemented. Phase 1–4 keep review state on the thread’s `CodingOrchestrator` DO (`reviewRounds[]`, `prBindings`).

## Problem

Thread-scoped review rounds work when one dashboard thread owns one PR. They strain when:

- Multiple threads or automations review the same `owner/repo#n`.
- Webhook-driven re-reviews and wake-ups need a stable PR key without scanning every run.
- Triage and round history should survive thread archival.

## Candidate: `ReviewDO` per pull request

**Name:** `ReviewDO`  
**Key:** `review:{owner}/{repo}#{number}` (one instance per PR).

### Owns

| Data | Notes |
|------|--------|
| `rounds: ReviewRound[]` | Same wire types as `packages/shared/src/review.ts` |
| `findingsTriage` | Optional overlay if triage should diverge from last posted round |
| `lastHeadSha` | Idempotency for synchronize |
| `codingRunId?` | Primary thread that opened the PR (hint, not authority) |
| `wakeCursor` | Last processed delivery id per wake kind |

### Does not own

- Sandbox runs, approvals, or dispatch — still `CodingOrchestrator`.
- GitHub write tokens — still Worker-only `review/publish.ts` and `review/merge.ts`.

### Interface (sketch)

```ts
// POST /internal/round/queue — orchestrator or Automations DO
queueRound(input: { roundId; headSha; reviewRunId; codingRunId? }): { ok }

// POST /internal/round/settle — after reviewer run completes
settleRound(input: { roundId; findings; summary; generation }): ReviewRound

// PATCH /internal/findings/:id/triage
setTriage(findingId, triage): ReviewRound

// GET /internal/state — dashboard + v1 read models
getState(): { rounds; latest }
```

GitHub posting stays on the Worker: `ReviewDO` returns the round to post; the orchestrator (or a thin Worker handler) calls `postReview` so tokens never enter the DO container path.

### Migration path

1. **Phase 4 (now):** orchestrator stores rounds; `prBindings` maps PR → coding run for wake.
2. **Phase 4.5:** dual-write rounds to `ReviewDO` behind a feature flag; read from DO on miss.
3. **Phase 5+:** webhook review lane targets `ReviewDO` first; orchestrator subscribes for thread UI projection.

### GOAL.md gate

Adding `ReviewDO` is a **new Durable Object** — requires an explicit exception in `spec/GOAL.md` (same bar as the plan’s shape B). Until then, this document is the contract reviewers can implement against.

### Why not now

- Phase 1 falsifiable slice required a single owner (shape A) to avoid cross-DO races on “is this PR reviewed?”
- Parallel agents already touch `orchestrator.ts`; splitting ownership mid-phase raises conflict and verification cost.

## Acceptance if built later

- Two threads on the same PR see the same triage and round list.
- `synchronize` enqueues at most one reviewer round per `headSha` cluster-wide.
- No GitHub token in sandbox; merge and review post remain approval-gated.
