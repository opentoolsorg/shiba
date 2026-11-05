# Integration, memory, and scheduler audit

Audit date: 2026-10-28. Reference: `LayerNorm/overlay-web` commit
`49146167572130e171db8d566edc0bf2f176aa73`. This report records source inspection
and the exact local tests below. Overlay was not installed or exercised against
its hosted services, so implementation presence does not establish that its
features work end to end.

## Comparison

| Feature | Overlay status | Shiba status | Evidence | Missing functionality | Priority |
|---|---|---|---|---|---|
| Persistent memory, knowledge, RAG | NOT VERIFIED | PARTIAL | Overlay `convex/knowledge/knowledge.ts` implements lexical/vector/temporal fusion, chunk packing, file/message/memory reindexing; `convex/knowledge/memories.ts` models owner/workspace visibility. Shiba `memory-do.ts`, `memory-store.ts`, `mcp-memory-tools.ts`, `memory-routes.ts`, `MemoryTab.tsx` implement bank/recall/forget/session listing, Vectorize embedding metadata, TTL purge and deduplication. Local memory/MCP tests passed. | No live Workers AI embedding/Vectorize round trip was executed. Shiba lacks Overlay's file/message ingestion and broad hybrid retrieval. Account/tenant isolation must be independently checked before treating cross-agent global recall as safe for an unrelated multi-user tenancy. | P0 isolation; P1 live proof; P2 hybrid retrieval |
| File upload/storage/semantic retrieval | NOT VERIFIED | PARTIAL | Overlay `convex/files/files.ts` has upload intents, scoped listing/mutation/sharing; `convex/files/ingestion/jobs.ts` has durable ingestion jobs and `knowledge.ts` indexes extracted sources. Shiba `email-handler.ts` and `inbox-routes.ts` store and retrieve R2 email attachments; `v1/system.ts` advertises `attachmentMaxBytes: 0`. | General chat file uploads and an ingestion/retrieval pipeline are missing. Email attachments are a separate capability and do not prove general upload support. No external R2 request was made. | P1 honest upload UX; P2 ingestion |
| Projects, notes, task organization | NOT VERIFIED | PARTIAL | Overlay's canonical files and knowledge views are in `convex/files/files.ts`, `src/features/files`, `src/features/knowledge`. Shiba `v1/threads.ts` reports the run's repository URL as `projectId`; saved repository/skill libraries are browser-local in `apps/frontend/src/saved.ts`. | Shiba has repository/run organization, not Overlay's shared canonical document workspace. Browser-local saved content is not a server-synchronized workspace library. | P2 |
| Agent skills and MCP | NOT VERIFIED | PARTIAL | Overlay `convex/integrations/skills.ts` and `mcpServers.ts` implement scoped CRUD and server authentication metadata; `/api/v1/mcps/*` includes OAuth and probe routes. Shiba `mcp-gateway.ts` scopes and audits inbound tool calls; `mcp-memory-tools.ts` pins writes/deletes to the verified principal. `v1/mcp.ts` explicitly rejects upstream server registration with 501. `SkillsView.tsx`/`saved.ts` save browser-local skill metadata; the new `skill-prompt.ts` forwards selected names, URLs and instruction notes to the composed task. | An inbound Shiba MCP gateway is not an upstream MCP registry. Harness sessions have no mounted external MCP servers. Skill repository URLs do not prove repository instruction loading; instruction-note forwarding is now implemented, with frontend validation reported separately. | P2 upstream registry |
| Third-party connections and permissions | NOT VERIFIED | PARTIAL | Overlay `convex/integrations/workspaceConnectors.ts` checks workspace membership and extension scopes. Shiba `integrations-routes.ts` reports configured Slack/GitHub/Linear metadata and explicitly returns `liveVerified: false`; Slack verification is a local HMAC self-test. Gmail and channel integration code exist. | No real Slack/Linear/Gmail delivery or authenticated provider call was performed. Local self-tests must not become a connected/verified production claim. | P1 live acceptance |
| Scheduled tasks/background jobs/retries | NOT VERIFIED | PARTIAL | Overlay `convex/automations/automations.ts:775` atomically claims due runs, applies per-user fairness and concurrency skip policy; `automationRunner.ts:130` dispatches service-authenticated execution. Shiba `automations.ts`, `automation-runner.ts`, `automations-do.ts` implement cron/timezone matching, daily run gates, approval queueing, frozen command/config retries, durable approval phases, batched-webhook backpressure and observable skips. Six relevant local suites passed after the state-loss and reliability fixes below. | Shiba stores only latest firing/skip for the automation view, not durable execution history (`v1/automations.ts`). Queue deduplication depends on bounded command-receipt retention; downstream approval task content is capped at 4000 characters. Real deployed cron, provider dispatch, crash recovery and receipt-eviction behavior were not exercised. | P1 deployed acceptance and task-size policy; P2 execution history |
| Subscription, billing, usage limits | NOT VERIFIED | PARTIAL | Overlay `convex/billing/*` implements Stripe reconciliation, spend limits and reservations; `spendLimits.ts` checks limits against committed usage. Shiba `v1/billing.ts` explicitly models a single self-hosted plan, reports harness-supplied model usage and marks VM cost unavailable; `usage.ts` parses daily model budget. `agents/orchestrator.ts` has separate container concurrency/daily budget enforcement. | Model budget `USAGE_BUDGET_USD` is advisory, not a spend enforcement mechanism. VM cost is unavailable. Hosted payment/subscription parity is NOT APPLICABLE to the current self-hosted product unless the product scope changes. | P1 honest limits; P2 optional hard spend gate |

## Reproduced scheduler defect and fix

`Automations.tick()` originally loaded automation state, flushed webhook batches
(which persisted new counts through `fireEvent()`), and then evaluated schedules
and saved the state loaded before the flush. That overwrote webhook counts and
daily charges. With a combined webhook/schedule automation and a daily limit of
one, the same tick could queue **two** runs. With separate webhook and schedule
automations, the webhook's persisted count returned to zero after the schedule
saved its state.

`apps/backend/test/automations-tick.test.ts` reproduced both failures against the
original implementation. `apps/backend/src/automations-do.ts` now reloads the
persisted state after batch processing, so schedule authorization sees the
webhook's daily charge and saving schedules retains all webhook counters. The
regressions also check that repeating the tick does not queue an extra run.
The queue stub returns a pending approval; these tests do not start a sandbox,
send a message, or call a provider.

## Final webhook reliability behavior and limits

The subsequent implementation in `automations-do.ts` retains a frozen batch
across transient queue/transport failure, backs off and retries with the same
command ID. Atomic storage transactions serialize ingress appends against batch
freezing. A durable five-minute attempt lease suppresses overlapping ticks, and
queue/approval requests carry a 30-second abort signal. New ingress receives
503 while a batch is frozen rather than being silently merged into an existing
queue identity. Permanent invalid input and never-attempted policy refusals
terminate with a visible skip; an ambiguous attempted queue pauses with backoff
when current policy blocks recovery.

The actual queue configuration is stored separately from payload bodies, so
later prompt/repository/custom-agent edits cannot change the request under the
same receipt identity. A returned approval ID and its one budget charge commit
together before optional unattended resolution. Resolution retries reuse that
approval without requeueing or charging again; both capacity refusal (409) and
service failure (503) are covered. Authorization uses current authority settings
against the frozen repository and PR flag, preventing a newly configured token
from promoting an originally non-PR approval to unattended execution.

Ingress accepts at most 32,000 UTF-8 bytes per body, 32 bodies per batch, and
96,000 bytes of serialized body data including JSON escaping. Overflow returns
413 or 429 with backpressure rather than truncating accepted ingress. Bodies are
stored once; frozen queue metadata uses a separate key to avoid doubling the
96,000-byte record above the Durable Object value limit. Both keys are cleaned
up on terminal outcomes.

These are bounded local contract guarantees, not unlimited exactly-once
delivery. The orchestrator retains only 256 command receipts; an ambiguous
delivery retried after its receipt is evicted can queue again. The orchestrator
also caps approval task text at 4000 characters, so ingress byte bounds do not
prove complete end-to-end delivery of large batched content. A production task
size/attachment policy remains necessary. The tests use fake durable storage
and HTTP stubs; real Worker crash/restart, scheduler delivery and provider
execution remain unverified.

## Executed checks

From `/workspace/shiba`, using `source /workspace/.tools/shiba-env.sh`:

| Command/check | Actual result | What it establishes |
|---|---|---|
| `pnpm -C apps/backend exec vitest run test/automations-tick.test.ts` before the source fix | FAIL: 2 tests failed | Reproduces budget bypass and counter loss. |
| `pnpm -C apps/backend exec vitest run test/automations-tick.test.ts test/automations-do-dedupe.test.ts test/automation-runner.test.ts test/automations.test.ts test/phase5-integrations.test.ts` after the fix | PASS: 5 files, 73 tests | Local scheduler gates, event matching, dedupe, integration signing/parsing and both fixed regressions. External providers and deployed cron remain unverified. |
| The same five suites plus `test/webhook-batch-reliability.test.ts`, independently rerun after reliability review | PASS: 6 files, 87 tests | Retained transient failures, restart/replay identity, frozen edited configuration, approval 409/503 recovery, atomic charging, policy pauses, overlap lease, ingress backpressure and UTF-8/serialized byte limits. |
| Final `test/webhook-batch-reliability.test.ts` rerun after adding the large-record regression | PASS: 1 file, 15 tests | Includes a 90,000-byte body batch and separate 20,000-character frozen prompt under an enforced 128 KiB per-value test limit. |
| `pnpm -C apps/backend exec vitest run test/memory-store.test.ts test/mcp-memory-tools.test.ts test/memory-tab.test.ts test/mcp-gateway.test.ts test/mcp-run-tools.test.ts test/mcp-email-tools.test.ts test/oauth-mcp.test.ts` | PASS: 7 files, 130 tests | Memory storage/API behavior and scoped MCP gateway/tool contracts under test fakes. No live embedding, R2, provider, or mail round trip. |
| `pnpm -C apps/backend exec tsc --noEmit -p tsconfig.test.json` | PASS | Backend tests typecheck, including the new regression fixture. |

The relevant UI/API trace for memory is `MemoryTab` fetch -> authenticated
`handleMemory` -> Memory registry/per-agent DO -> SQLite/Workers AI/Vectorize ->
JSON response -> React state. The test evidence covers local contracts using
fakes; the external services and actual browser journey were not run by this
audit agent. The scheduler trace is Worker `scheduled()` -> Automations DO tick
-> match/predicate/budget/approval gates -> orchestrator pending approval ->
persisted counters. The regression executes the DO tick and real fire logic
with fake durable storage and a queue HTTP stub.

## Priorities and patterns to adapt

1. **P0:** Finish tenant and owner isolation checks before exposing shared
   memory or integration management to unrelated users. Do not replace
   intentional scoped writes with account-wide credentials in agent runtimes.
2. **P1:** Execute deployed scheduled-Worker recovery acceptance using the new
   durable retry/phase/bounds implementation. Add a production task-size policy
   covering the downstream 4000-character approval cap, and define recovery
   after a bounded command receipt has been evicted. Local retry regressions
   now pass; they do not establish deployed exactly-once delivery.
3. **P1:** Keep capability/status labels accurate. A configured secret, a
   self-test, an API route, or a model flag does not establish a successful
   provider operation. Preserve explicit 501 responses for unsupported upstream
   MCP registration and unavailable attachment limits.
4. **P2:** Adapt Overlay's explicit run claims/status history, concurrency skip
   policy, fair per-user scheduling, and source provenance where Shiba needs
   them. These patterns fit SQLite/Durable Objects; adopting Convex is not a
   prerequisite.
5. **P2:** Add canonical workspace documents and scoped ingestion only if they
   serve the software-engineering workflow. Copying Overlay's entire document
   editor, Stripe commerce stack, connector vendor, or hybrid search machinery
   would expand product and operational scope without proving core coding runs.
