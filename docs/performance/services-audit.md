# Services audit — ancillary network, storage, and scheduling hot paths

Scope: worker-3 lane from `.omx/context/performance-audit-20261015.md` — ancillary
network (fetch fan-out, GitHub/Slack/Discord/email egress), storage (KV, D1, R2,
Vectorize, DO storage), and scheduling (cron, alarms, timers, retries).
Read-only audit; no product edits. All numbers are estimates from static call-graph
reading — no live timings were captured (none permitted). Frontend polling and
backend run-streaming/serialization are owned by workers 1 and 2 and are excluded
except where an ancillary path crosses them.

Method: tgrep/grep over `apps/backend/src` (121 .ts files) plus wrangler config and
shared packages. Call paths are given as `file:line` from the worktree.

## Ranked findings (top 5)

Assumptions: estimates are order-of-magnitude bounds from code structure, not measured timings; RTT means one network/storage round-trip; DO operation counts assume worst-case observed code paths, not average-case caches.

### P1 — Delivery dedupe does a full `dedupe:*` storage scan + sweep on every inbound event

Call graph:
`index.ts:299` (telegram), `index.ts:313` / `slack-routes.ts:197` (slack),
`discord.ts:151` -> `automations-stub.ts:13` `seenDelivery()` -> DO fetch
`POST /internal/dedupe` -> `automations-do.ts:274` `storage.get(dedupe:key)`
-> `automations-do.ts:279` `storage.list({prefix:"dedupe:"})` -> filter ->
`automations-do.ts:283-284` chunked `storage.delete`.

Evidence: every single delivery check reads **all** dedupe keys back from DO storage
(`list` with no limit) and may issue up to N/128 delete calls. Three inbound
surfaces (Slack events + slash commands, Discord interactions, Telegram updates)
funnel through this, so cost is per-event, not per-hour.

Estimate: O(total dedupe keys) storage read ops + serialized delete round-trips per
inbound webhook. With the 1-hour TTL the set is normally small (tens of keys), but a
Slack retry storm or busy channel inflates it, and every event pays the list even
when there is nothing to sweep. DO storage list+delete ops are billed per operation.

Fix (preserves dedupe contract): sweep opportunistically — e.g. only when
`now - lastSweepAt > 5min` stored under a `dedupe:meta` key — or move expiry to a
DO alarm; keep the per-key `get`/`put` on the hot path unchanged. The
check-and-record semantics (durable dedupe) are untouched.

Validation: unit-test that a second delivery still dedupes while the sweep is
skipped; assert `list` is not called when the sweep window has not elapsed
(existing tests in `apps/backend/test` cover dedupe behavior).

### P2 — `fireMatchingAutomations` runs automations strictly serially; each match can block on an AI call

Call graph: `automations-do.ts:117/139` `fireEvent/tick` ->
`automation-runner.ts:268-273` `for (const automation ...) await fireAutomation(...)`
-> `automation-runner.ts:200-209` `evaluateRunWhen` -> `automations.ts:676`
-> `automations.ts:648` `postSystemOne` (TypeSafe HTTP) or
`automations.ts:690` `ai.run` (Workers AI).

Evidence: a single Slack/GitHub/webhook event iterates every automation
sequentially. Each automation with a `run_when` clause pays one network-bound
model verdict inside the loop, and `queueRun`/`resolveApproval` are further DO
fetches to the orchestrator stub (`automations-do.ts:48,65`).

Estimate: latency ~ sum over automations of (match + optional model call + up to 2 DO
round-trips). With k automations and m run_when clauses the event handler is O(k)
serialized network calls; at cron cadence (`*/5`) a stalled model call delays the
rest of the batch and can approach the DO request budget for the tick.

Fix: evaluate run_when verdicts with `Promise.allSettled` per matched automation
(matches are independent; the merge step in `fireEvent` already reconciles by id),
keeping burst-window and approval gates untouched since they are per-automation.

Validation: existing automation tests should still pass; add a test asserting
two automations with run_when evaluate concurrently (e.g. via deferred fetchImpl).

### P3 — Daily memory sweep re-embeds every fact and runs O(n^2) cosine comparisons

Call graph: `memory-do.ts:365` `alarm()` -> `memory-do.ts:578` `sweep()` ->
`memory-do.ts:588` `embedMany(facts.map(f => f.fact))` ->
`memory-do.ts:590-620` nested kept.findIndex(cosineSimilarity) per fact,
plus per-merge `deleteVector`/`dropRegistryEntry`/`upsertVector` calls
(`memory-do.ts:610-620`).

Evidence: once per day **per memory stub** (one DO per agent), all surviving facts
are re-embedded via Workers AI (one call, but payload grows with fact count), then
compared pairwise in JS — O(n^2) x 768-dim float math — followed by per-merge
Vectorize delete + registry DO fetch + possible vector re-upsert.

Estimate: for f facts, f-vector re-embed + f(f-1)/2 cosine computations + up to
3 Vectorize/DO ops per merge. Embedding identical texts daily is pure recompute;
stored vectors could be reused (they are already written at bank time,
`memory-do.ts:760`).

Fix: fetch stored vectors from `MEMORY_VECTORS` (or persist the embedding in DO
storage at bank time) instead of re-embedding; early-exit the pairwise loop by
bucketing or cap sweep batch size per alarm. Approval/security boundaries unaffected.

Validation: seed >=2 near-duplicate facts in a test stub, run `sweep()`, assert
merge still occurs and that `AI.run` is not invoked when vectors are cached.

### P4 — GitHub PR path creates blobs serially (N+1 API calls per file)

Call graph: `github.ts:103-160` `createBranchAndPr` -> `github.ts:115-129`
`for (const file of request.files) { await api(.../git/blobs) }`.

Evidence: each changed file costs one serialized `POST /git/blobs`. A run that
touches F files issues F sequential round-trips before the tree/commit calls.

Estimate: F x RTT to api.github.com added to the publish step; independent calls
can be parallel (blob creation has no interdependency) — ~Fx speedup on that stage.

Fix: `Promise.all` over `request.files` for blob creation, preserving order of
the resulting sha list for the tree payload.

Validation: mock fetchImpl counting concurrent inflight requests; assert tree
entries match input file order.

### P5 — Cron tick wakes two DOs every 5 minutes regardless of work

Call graph: `wrangler.jsonc:97` `crons: ["*/5 * * * *"]` -> `index.ts:110-122`
`automationsStub.fetch(/internal/tick)` + `index.ts:127-139`
`CodingOrchestrator.fetch(/internal/sweep-drafts)`. `tick` then does
`automations-do.ts:135-136` `load()` (full-state `storage.get`) even when
nothing is due, and `automations-do.ts:139-140` calls
`fireMatchingAutomations(store.list(), ...)` on **all** automations rather than the
precomputed `due` subset (cheap early-return per non-match, but a wasted loop and
full-store rewrite at `automations-do.ts:144-146`).

Evidence: 288 ticks/day; each keeps the "default" Automations DO and the shared
orchestrator DO warm (DO duration billing), plus a full-state read per tick.

Estimate: small per-tick cost but continuous; the orchestrator wake is the
dominant term since it pins a large DO every 5 minutes idle. Passing `due`
instead of `store.list()` is a free correctness-preserving reduction.

Fix: (a) early-exit the draft sweep when no `sending` drafts are cheaply known —
or fold it into the same tick request; (b) pass `due` to
`fireMatchingAutomations`; (c) persist a lightweight `nextDueAt` alongside
state so `tick` can skip `load()` entirely when nothing is due.

Validation: unit-test `tick` with zero due automations asserting no storage.get
beyond the due-index read; existing sweep tests cover draft-release behavior.

## Minor observations (not ranked)

### Outbox drainer executes entries serially

Call graph: `orchestration/outbox.ts:40-52` `drainOutbox` —
`for (const entry of dueEntries(...)) { await execute(entry) }`.

Evidence: Slack posts / email sends / webhook emits drain one at a time. A slow
endpoint delays every later effect in the batch.

Estimate: sum of per-entry external latency; independent entries could run
concurrently (results are already collected per-entry and persisted in one state
write, so ordering is not a correctness requirement — verify no entry depends on a
prior entry's side effect before parallelizing).

Fix: `Promise.allSettled` over due entries if ordering is confirmed irrelevant;
otherwise batch only same-kind entries. Keep `attempts`/retry semantics.

Validation: existing outbox tests; add ordering assumption check.

### `listTokens` does KV N+1 (list pages -> get per key)

Call graph: `agent-tokens.ts:236-247` — `AGENT_TOKENS.list({prefix})` page loop,
then `kvGet` per key.

Evidence: admin-only surface, so low frequency — but cost grows linearly with
token count; each page triggers K sequential `get` calls.

Estimate: T keys -> ceil(T/1000) list ops + T get ops, serialized per page.

Fix: store the record JSON as KV `metadata` on the key at mint time
(`agent-tokens.ts:174` put) so `list` returns records without the N+1; or
parallelize gets within a page. Admin route only — low priority.

Validation: list tokens in test env before/after; compare record equality.

### Trigger + OAuth rate limits use non-atomic KV read-modify-write per request

Call graph: `trigger.ts:32-46` `triggerRateLimited` (`kv.get` then `kv.put`),
same pattern at `oauth-mcp.ts:151-155`.

Evidence: two KV ops per request on the hot auth path; the increment can lose
updates under concurrent requests from one IP (tolerable for rate limiting, but
worth noting) and every trigger call pays 2 KV round-trips.

Estimate: 2x KV latency on each request to these endpoints; under-per-minute
windows make drift bounded at +/-concurrent-requests — acceptable, low priority.

Fix (optional): accept drift as-is, or move counters into a DO/Rate Limiting
binding if precision ever matters.

## Notable non-findings (checked, judged acceptable)

- `mailbox-store.ts` threading (`findThreadId` `mailbox-store.ts:521-558`):
  bounded candidate loop over indexed DO-SQLite queries inside one transaction —
  O(#references) small integer lookups, fine.
- Email attachments use `Promise.allSettled`/`Promise.all` for R2 puts
  (`email-handler.ts:260,281`) — already parallel.
- `audit.ts:88-101` single prepared D1 insert per audit event, DDL cached per
  isolate via WeakSet (`audit.ts:72`) — no per-request DDL cost.
- `runtime.ts:421` `LOCAL_POLL_INTERVAL_MS = 2500` fixed poll for the local
  dispatch adapter only (opt-in runtime); acceptable but a backoff or webhook
  would cut idle polls.
- `automations-do.ts:283-284` already chunks storage.delete at 128 — correct,
  just called too often (see P1).
- Memory `bank` correctly short-circuits registry stub and bounds input sizes
  (`memory-do.ts:628-650`).

## Cross-lane handoffs

- The orchestrator stub fetches issued here (`automations-do.ts:48,65`) land on
  worker-2's execution lane; serialization inside the orchestrator itself is
  out of scope for this report.
- `seenDelivery`'s DO fetch adds latency to each inbound webhook surface; if
  worker-2 finds DO fetch overhead in the orchestrator path, the same stub-fetch
  pattern is the mechanism here.
