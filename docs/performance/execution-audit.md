# Backend execution / streaming / serialization audit — worker-2

Scope: run orchestration, exec-output streaming, and serialization in `apps/backend/src` (plus the `@cloudflare/think@0.18.0` base-class paths that code reaches). Read-only audit; no product edits. All timings are isolated-benchmark estimates, not production measurements. Approval-gating behavior is untouched by every suggested fix.

Caller path shared by findings 1–2:
`POST /api/runs` → `queueSlackRun` → run effect → `childExecute(formatAgentToolInput)` (`agents/orchestrator.ts:1054`) → `OpenCodeAgent` chat-stream `execute` (`agents/opencode-agent.ts:241`) → `adapter.runCodingTask(ops, input, emit)` (`agents/opencode-agent.ts:306`) → `SandboxRuntimeAdapter.runCodingTask` → `streamProgress(harness, emit)` (`runtime.ts:258,662`) → per-line `emitText` → `emit` (`agents/opencode-agent.ts:256`) → `reportProgress` (`agents/opencode-agent.ts:263`) → `AgentToolProgressEmitter.report` (think.js:4616) → `_broadcastChat` + SQL `UPDATE cf_agent_tool_child_runs SET progress_json` (think.js:4585-4613).

## F1 — Unbounded no-newline stdout buffer with O(n²) rescans in `streamProgress` (HIGH)

Evidence: `runtime.ts:683-690` — `onData` does `buffer += data` then `buffer.indexOf("\n")` from offset 0 on every chunk, and `buffer.slice`s per completed line. `MAX_PROGRESS_EVENTS` (runtime.ts:50, 667) bounds emitted events, not buffer size or parse work.

Reachability: the buffer holds stdout of a coding agent running inside the sandbox — text the agent process controls. Any long line (minified JSON, a base64 blob, a stack dump, or output with no trailing newline) grows it without bound for the whole exec; delivery fragmented into small chunks makes every `onData` rescan the accumulated string.

Impact estimate: leader benchmark of the source-extracted loop (`docs/performance/stream-buffer-benchmark.mjs` in leader cwd) — 1 KiB no-newline fragments, median of 3: 256 KiB → 4.7 ms, 1 MiB → 81.7 ms, 2 MiB → 329 ms; clearly quadratic. DO isolates are single-threaded: a multi-MiB line stalls every other request/alarm on that orchestrator DO, and the retained string is unbounded memory inside the 128 MiB isolate.

Fix (no behavior change for well-formed streams): cap the pending-line buffer (e.g., 64–256 KiB); on overflow emit/flush one truncated line and reset, or track a scan offset instead of re-running `indexOf` from 0. Do NOT stop parsing after the progress cap — usage/error events must still be consumed (current code already keeps parsing after `emitted >= MAX`; a truncation fix must preserve that or a trailing usage line is lost).

Validation: unit test feeding 1 KiB fragments of a 2 MiB no-newline line — assert bounded memory and sub-linear time; a subsequent valid usage/event line on the same stream still parses; malformed-line path still emits the redacted notice.

## F2 — One durable SQL write + one WS broadcast per progress event (MEDIUM)

Evidence: `emit` wrapper (`agents/opencode-agent.ts:256-266`) caps at 100 events / 20 KB chars per run, then calls `await this.reportProgress(...)` per event. `reportProgress` → think.js `AgentToolProgressEmitter`: per event it broadcasts a `MSG_CHAT_RESPONSE` chunk to every connected socket (think.js:4589-4597) AND runs `UPDATE cf_agent_tool_child_runs SET progress_json = JSON.stringify(snapshot)` (think.js:4598-4608). There is no time-coalescing — count is the only bound.

Impact estimate: worst case ≈100 SQLite writes + 100 broadcast serializations per run on the orchestrator DO's SQL storage; with several concurrent runs on one DO this is a steady write+broadcast stream for a value only the latest of which is ever read (`_progressSnapshotFromRow` returns the last row only, think.js:4559-4577).

Fix: coalesce snapshot persistence (e.g., persist at most every N ms / on phase change, always persisting the last one before settle); broadcasting can stay per-event since it is the live UI channel. Keeps progress observable, removes most redundant durable writes.

Validation: run the existing opencode-agent/progress tests; add a counter assertion that a run emitting N progress events performs ≤ ceil(N/k)+1 snapshot writes; confirm a late-joining client still rebuilds the latest snapshot.

## F3 — `setState` persists the entire `OrchestratorState` on every mutation (MEDIUM)

Evidence: `setState` (`agents/orchestrator.ts:445-449`) → `applySpine` copies the retained log on every write: `next.events = [...priorLog, ...appended].slice(-MAX_SPINE_EVENTS)` (`orchestrator.ts:431-432`, `MAX_SPINE_EVENTS = 1000`, packages/shared/src/events.ts:121). Every run transition, receipt (`recordReceipt`), spine event, outbox fold, leak hook (`orchestrator.ts:2539-2550`), and outbox drain commit (`orchestrator.ts:2510`) serializes+stores the whole object: `runs` (each carrying receipts, diff ≤20 KB, summary ≤4 KB), `pendingApprovals`, `commandReceipts`, `events` ≤1000, `outbox`.

Impact estimate: state size grows with run history (registry is append-only until Clear). One queue→resolve→run cycle performs well over a dozen full-state serializations; with a long registry this is hundreds of KB serialized per mutation. Bounded but multiplicative with activity.

Fix options (pick smallest): (a) prune `commandReceipts` and compact receipt payloads on terminal runs; (b) move the spine tail to separate storage keys so routine mutations don't reserialize it; (c) cap retained `runs` or offload terminal-run bodies like the T44 diff export already does.

Validation: instrument a test that counts `ctx.storage.put` bytes across a synthetic run lifecycle; assert no growth per additional historical run.

## F4 — Unbounded default run-list serialization on every dashboard GET (MEDIUM)

Evidence: `agents/orchestrator.ts:3284-3306` — GET `/api/runs` without `limit` maps `serializeRun` over the entire registry (full `DelegatedRun` incl. receipts/diff/summary per run) per request, per client. The `limit` param exists (`orchestrator.ts:3294-3305`, capped 500) but is opt-in; the unbounded branch is the default. Each GET also runs `reclaimRunsForRead` → `drainEffectOutbox` (`orchestrator.ts:3286,2450`) — cheap when the outbox is empty, an I/O pass when it is not.

Impact estimate: response bytes = O(total runs × per-run payload). With receipts and 20 KB diffs this can reach MB-scale JSON per poll; combined with frontend poll cadence (worker-1's lane) it is a repeated serialization+transfer cost.

Fix: default a bound (e.g., newest 100) when `limit` is absent, or paginate; the terminal fields the dashboard list view needs could ride a slim projector. No contract change required — `limit` semantics stay.

Validation: seed N runs, measure response bytes/time with and without limit; confirm dashboard list still renders (worker-1 verifies consumer side).

## F5 — O(A²) approval diff inside `applySpine` (LOW)

Evidence: `agents/orchestrator.ts:402-418` — for every approval in `after`, `before.find(...)` scans the prior array → O(A²) per `setState`, plus a `Set` build over inputs.

Impact estimate: approvals are operationally small (a handful per user DO), so the absolute cost is minor; listed for completeness. Fix: index `before` into a Map keyed by `approvalId+threadKey` once — one-line-complexity change, O(A).

## Not findings (checked, bounded)

- `collectStream` read cap 500 KB (`agents/opencode-agent.ts:155`) — bounded.
- `boundTail` on stderr/stdout tails (`runtime.ts:306,546`) — bounded.
- Stderr is ignored by `streamProgress.onData` (`runtime.ts:679-680`); the "stderr is only counted" comment at runtime.ts:656 is stale — docs-only nit, not a perf issue since stderr tail is bounded via `boundTail`.
- `JSON.stringify(output).slice(0,2000)` (`orchestrator.ts:1168`) stringifies the whole output before slicing — error path only, low frequency; could slice first if output is ever huge.
- `store.list()`/`store.get` linear scans — O(runs) per call, registry-size dependent; acceptable at current scale, revisit with F4.
