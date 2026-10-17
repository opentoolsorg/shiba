# Shiba performance audit — 2026-10-15

## Scope and evidence limits

Target: this repository at initial revision `eb80e4a`; inferred flow is dashboard → approval → coding execution/progress → optional PR publication. Ancillary webhook/automation/memory paths were also reviewed because no narrower flow or binary was supplied. This is an **analysis, not an implementation**.

Three OMX Team workers were launched with `--model devin/swe-2`. REA's installed instructions explicitly route complete source repositories to ordinary repository analysis; no native binary, decompilation, live capture, or REA Evidence ID is claimed. Evidence below is source call graphs plus one source-extracted Node benchmark. Static reachability is not proof of production frequency.

Ranking is provisional expected gain for an active dashboard with growing history and multi-file PRs, not convenience. No production latency distribution, token count, history size, or request rate was available. Conditional costs are identified: with no PR publishing, rank 1 disappears; with very few tokens, rank 3 drops; unusually long stdout lines promote rank 5 to first priority. RTT examples are arithmetic assumptions, not measured service latency.

## Ranked findings

### 1. Serial per-file GitHub blob uploads extend the publish critical path

**Evidence/call graph:** `OpenCodeAgent` publish path → `createBranchAndPr` → `github.ts:115-129`: each non-deleted file awaits `POST /git/blobs` before the next. The later tree → commit → ref → PR calls really are dependent (`github.ts:131-157`) and should remain ordered.

**Impact:** F non-deleted files add approximately F×R latency, where R is a blob-request RTT. At illustrative F=20 and R=100 ms, blob creation alone adds ~2 s. Bounded concurrency 4 reduces this to ~5 waves / 0.5 s, saving ~1.5 s in that stage, not a 4× speedup of the whole agent run. Request count is unchanged.

**Fix:** validate *all* paths first, then upload independent blobs with a small concurrency limit and stable result ordering. Retain deletion entries, rate-limit/backoff, abort handling, failure propagation and dependent commit/PR order. Do not use unlimited `Promise.all`.

**Validation:** mocked deferred fetches assert ≤4 inflight blob requests, all path checks precede uploads, correct tree SHA mapping, deletions, failure behavior and no commit on blob failure.

### 2. Timeline rendering repeatedly traverses history and serializes unchanged tool output

**Evidence/call graph:** chat message update → App → `StepTimeline` → `messages.map` (`components/StepTimeline.tsx:122`) → `message.parts.map` (`:131,152`) → `renderToolOutput` (`:174`) → default `JSON.stringify(output, null, 2)` (`:45-50`). No memoized row boundary protects historical messages. React keys preserve identity but do not skip this work.

**Impact:** C renders over P retained parts and B bytes of object-valued tool output cost approximately O(C×(P+B)), with new React elements and JSON strings allocated repeatedly. Example: 100 updates over 1 MB of historical object output serialize ~100 MB cumulatively. That is an illustrative workload, not retained heap size or a measured UI stall. String-valued outputs avoid stringify but not traversal.

**Fix:** isolate memoized message/tool rows and memoize output formatting by immutable output identity. Include approval decisions, pending-approval lookup, callbacks and all visible state in memo dependencies; comparing only message IDs would freeze approval cards. Window older history only if measurements still justify it; no new dependency is necessary initially.

**Validation:** React Profiler with long history + streaming active message; count unchanged output formatter invocations. Regression-test approval appearance, exact input, decision updates and completed output.

### 3. A 10-second UI poll hides sequential KV N+1 lookups

**Evidence/call graph:** `useAgentPrincipals` → `fetch('/api/agents')` + `setInterval(...,10_000)` (`app.tsx:175-201`) → `meta-routes.ts:80-86` → `agentPrincipals` (`:26-31`) → `listTokens` (`agent-tokens.ts:235-248`) → page `list` and one awaited `kvGet` per token (`:240-242`). Revoked records are included. The response is `no-store`.

**Impact:** one enabled tab with T records performs roughly 6T KV gets/minute plus page listings, excluding initial/explicit refreshes. T=100 means ~600 gets/minute/tab, and response critical path includes T serial gets. Multiple tabs multiply the demand. Thus this is not merely a rarely opened admin list. Overlapping slow polls can add load even though stale UI responses are fenced.

**Fix:** pause hidden-tab polling, allow only one inflight refresh and use completion-driven backoff. Reduce lookup latency with bounded concurrency. To actually remove N gets, consider a listing-specific projection or non-sensitive KV metadata, with mint/revoke/update consistency explicitly designed; never cache token verification or expose bearer/hash material in the UI. Reuse existing primitives.

**Validation:** fake-timer/request-count tests; multi-page token-list equivalence including revoked records; inflight cap; visibility resume; verify authorization/revocation checks are unchanged.

### 4. Growing run history amplifies state writes and list serialization

**Evidence/call graph:** run transition / approval / receipt → `CodingOrchestrator.setState` (`agents/orchestrator.ts:445-448`) → base state persistence. On pending spine events, `applySpine` copies retained event arrays (`:429-437`); empty event batches return early. GET `/api/runs` → `serializeRun` (`:2532-2533`) → full registry `.map` → `Response.json` when `limit` is absent (`:3287-3306`). `useRetainedRuns` requests a session URL or the unbounded fallback without `limit` (`app.tsx:58-90`).

**Impact:** state work scales with serialized state S per mutation and list work with returned run payload H per refresh. M mutations cost O(M×S); K list refreshes serialize/transfer O(K×H). 100 retained 20 KB diff previews alone are ~2 MB before receipts/summaries. These are payload-scale examples, not observed history. The frontend 3-second streaming refresh is **one-shot/dependency-triggered**, not continuous 3-second polling (`app.tsx:815-821`).

**Fix:** first measure state/response bytes. Have compatible consumers explicitly request a bound/pagination and a lean list projection, with full details fetched on selection. Changing the existing endpoint's default silently is an API contract change. Compact terminal payloads / archive large bodies only with explicit retention and replay semantics. Preserve atomic approval+spine+receipt commits; splitting storage blindly is unsafe.

**Validation:** seed realistic historical runs; measure bytes and writes over one lifecycle; ensure pagination has no omissions/duplicates and session/principal scoping remains identical. Test eviction/recovery and approval/outbox atomicity before changing persistence layout.

### 5. Fragmented stdout with no newline triggers quadratic scanning and unbounded buffering

**Evidence/call graph:** `SandboxRuntimeAdapter.runCodingTask` (`runtime.ts:258,263-268`) → sandbox exec `onOutput` → `streamProgress.onData` (`:679-686`) → append whole chunk and search the accumulated buffer from offset zero. Event limits constrain reporting, not pending-line length. This CPU work executes in the coding `OpenCodeAgent` context, not the parent orchestrator.

**Measured synthetic evidence:** [benchmark](stream-buffer-benchmark.mjs), [raw results](stream-buffer-results.json). The script extracts the actual function, strips TypeScript using Node's built-in helper, and calls it with 1 KiB fragments lacking newlines. Node v24.13.0, three trials, median:

| Input | Median CPU wall time | Characters searched by algorithm |
|---|---:|---:|
| 256 KiB | 4.683 ms | 33,685,504 |
| 512 KiB | 22.614 ms | 134,479,872 |
| 1 MiB | 81.738 ms | 537,395,200 |
| 2 MiB | 329.052 ms | 2,148,532,224 |

Doubling 1→2 MiB causes ~4× runtime. This is a deliberately adverse input, not a captured normal CLI stream, process heap measurement or Workers timing. The script does not exercise JSON parsing, sandbox I/O or the full application.

**Fix:** track the unsearched offset / scan incoming chunks once, and enforce a maximum pending-line size. For oversized structured records, fail honestly or discard until the next delimiter with an explicit error policy; blindly chopping JSON into valid-looking events is unsafe. Continue parsing usage and failure events after the UI progress cap. Preserve redaction and cancellation.

**Validation:** fragmented long-line regression, bounded pending state, arbitrary delimiter splits, valid event following overflow, usage/error events after display cap; rerun benchmark with fixed implementation to establish linear scaling. This is the clearest measured algorithmic issue, but its expected frequency is unknown.

### 6. Each new inbound delivery scans the entire dedupe-key namespace

**Evidence/call graph:** Slack/Discord/Telegram ingress → `seenDelivery` (`automations-stub.ts:13`) → Automations DO `/internal/dedupe` → key lookup (`automations-do.ts:273-275`) → for a new key, put + unbounded-prefix list (`:278-280`) → allocate `[...all.keys()]` and filter → chunked stale deletes (`:283-284`). Already-seen deliveries return before the scan.

**Impact:** O(D) entries materialized per **new** event; N novel events before cleanup can cause ~N(N+1)/2 entry visits. A 1-hour cleanup horizon bounds steady-state history by traffic, not a fixed key count. List is one API call returning many entries, not D separate network calls; delete calls are already chunked to 128.

**Fix:** schedule/batch expiry cleanup or throttle a separate sweep, keeping durable per-key dedupe checks on the ingress path. Preserve replay semantics; elapsed wall time alone must not accidentally bypass dedupe. Use a separate metadata namespace if tracking sweep time.

**Validation:** duplicate replay still bypasses work; novel events avoid full scan within a sweep window; stale cleanup resumes safely and deletes never exceed 128 keys/call.

### 7. Automation verdicts run serially, adding head-of-line network latency

**Evidence/call graph:** Automations event/tick → `fireMatchingAutomations` (`automation-runner.ts:261-273`) → awaited `fireAutomation` in a loop (`:268-269`) → matching/burst check → optional `evaluateRunWhen` model request (`:198-207`) → authorization → queue/optional decision (`:214-232`).

**Impact:** m matching AI predicates with latency L contribute approximately m×L to batch completion rather than a bounded number of waves. For illustrative m=5, L=1 s, serial predicates cost ~5 s. This affects automation batches, not every interactive run. No actual model RTT was captured.

**Fix:** consider bounded concurrency for pure predicate evaluation only, then recheck and commit budget/burst/approval-sensitive decisions in a controlled order. Do not parallelize whole `fireAutomation` calls without proving budget and idempotency safety. The model call currently precedes authorization, so a cheap preflight rejection may also avoid obviously unnecessary verdict requests, but must preserve decision semantics.

**Validation:** deferred predicate requests show bounded overlap; concurrent events do not overrun budgets, duplicate runs, bypass human approval or alter unattended allowlists.

## Lower-priority bounded work / non-findings

- Memory sweep (`memory-do.ts:578-620`) re-embeds and pairwise-compares **up to 50 facts by default**, not every stored fact: `memory-store.ts:114,130-137,270-275`. Worst case 1,225 cosine comparisons at 768 dimensions for this default batch. Reusing versioned embeddings may save one model call/day per active memory stub; investigate model-refresh intent and cache invalidation first. Not a top hot-path win.
- Progress emits at most 100 events / 20,000 characters in `opencode-agent.ts:255-263`; SDK progress snapshots may still write/broadcast per event. Verify actual SQL/write counters before changing framework persistence. Do not trade recovery guarantees for presumed savings.
- Activity view sorting/rendering is capped by 1,000 retained spine events. Memoizing a sort is less likely to matter than the ranked network/serialization issues without profiler evidence.
- `collectStream` is bounded to 500 KB by default and joins chunks once. Do not present it as an unbounded allocation bug.
- Outbox ordering may encode externally visible dependencies. Serialization is not itself proof it can safely run in parallel; excluded from top recommendations pending dependency evidence.

## Verification and artifacts

- `pnpm -C apps/backend test test/runtime.test.ts test/transcript.test.ts`: **2 files, 64 tests passed**, 2026-10-15.
- `pnpm exec biome check --formatter-enabled=false --assist-enabled=false docs/performance/stream-buffer-benchmark.mjs`: passed.
- Benchmark executed successfully; raw values retained above and in JSON.
- No optimization implemented, deployment performed, sandbox launched, secrets read, or live service request made by this audit. Full typecheck/lint/build/deploy gates were not run: there are no product-code changes to validate. Targeted tests are baseline evidence, not evidence proposed fixes work.
- An unrelated `apps/backend/test/dashboard-unknown.test.ts` modification appeared during the audit; every worker denied ownership and it was left untouched.
- Lane detail: [frontend](frontend-audit.md), [execution](execution-audit.md), [services](services-audit.md). This consolidated report supersedes preliminary lane priorities and overbroad estimates.

## Team execution record

Launch: `OMX_TEAM_WORKER_CLI=codex OMX_TEAM_WORKER_LAUNCH_ARGS='--model devin/swe-2' omx team 3:executor '<scoped audit task>'`.

Team: `read-omx-context-perf-33d18519`; tmux `omx-ai-intern-main-1792057842081-xyya5n:0`; worker panes `%19`, `%20`, `%21`. All three initialization ACKs recorded in leader mailbox. Runtime selected worktree isolation and confirmed `actual_model=devin/swe-2` for all workers. Initial task ownership incorrectly assigned all tasks to worker-1; workers 2/3 returned scoped evidence and worker-1 closed task lifecycle after receipt. Final counts: 3 completed, 0 pending/in-progress/blocked/failed. Runtime auto-checkpointed/merged the three report files; no product implementation was requested.

Shutdown: `omx team shutdown read-omx-context-perf-33d18519` reported complete; runtime state directory under `$OMX_ROOT/.omx/state/team/read-omx-context-perf-33d18519` was removed. Workers were idle before shutdown. The leader copied corrected reports before shutdown, so automatic final merges refused to overwrite those local changes. This was an integration-only conflict, not lost work: each local report was byte-compared with its final worker checkpoint (`b6d9935`, `a23e9f5`, `f9f6ec5`) and matched exactly. Corrected reports remain in the leader working tree; unrelated test edits remain untouched.
