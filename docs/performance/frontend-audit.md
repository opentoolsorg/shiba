# Frontend performance audit — dashboard polling & rendering

Scope: apps/frontend (React dashboard), read-only. Audit date: 2026-10-15.
Owner: worker-1. All timings are estimates from static analysis, not
measurements; expected impact is ranked qualitatively.

## Call-graph summary

- Dashboard mounts a WebSocket chat (agents/react useAgent/useAgentChat)
  plus REST pollers: useStoredApprovals, useAgentPrincipals (10s each,
  view-gated), useRetainedRuns (on refreshToken), RemoteAccessView fleet
  poll (10s), ActivityView spine poll (5s, incremental cursor).
- Chat path: WebSocket message -> chat.messages state -> StepTimeline
  re-renders every message part on every stream chunk.

## Findings (ranked)

### F1 — StepTimeline re-renders the entire message log on every stream chunk (HIGH)
- Evidence: components/StepTimeline.tsx:122,131,152 — messages.map and
  nested message.parts.map; no React.memo, no per-message memoization,
  no virtualization. app.tsx:2023 passes chat.messages.
- Caller->callee: agents WebSocket onmessage -> useAgentChat setMessages
  -> App re-render -> StepTimeline messages.map -> per-part
  defaultRenderToolOutput -> JSON.stringify(output, null, 2)
  (StepTimeline.tsx:50).
- Cost: O(total message parts) DOM reconciliation plus O(bytes of every
  tool output) JSON.stringify per streamed chunk. A long run with N tool
  calls pays N times full-output serialization per token burst.
- Expected impact: largest win. Fix: React.memo per-message row keyed on
  (id, parts reference); cache renderToolOutput per part key; consider
  part-level memo. Approval gate behavior unchanged — getToolPartState
  is pure.
- Validation: React Profiler before/after during a streamed run; unit
  test that the pendingApprovals join still resolves (StepTimeline.tsx:175).

### F2 — Streaming tick refreshes full run list plus remap/resort every 3s (MEDIUM)
- Evidence: app.tsx:816-821 — while chat.status==="streaming",
  setTimeout(refreshRuns, 3000); refreshRuns bumps refreshToken ->
  useRetainedRuns refetches GET /api/runs (app.tsx:58-101) -> allRuns
  useMemo rebuilds a Map over toolRuns+retainedRuns and sorts
  (app.tsx:1135-1182).
- Cost: 1 request/3s per streaming session plus O(runs) map+sort per
  refresh, even though live tool events already arrive over the socket
  via useAgentToolEvents (app.tsx:585).
- Fix: poll retained runs only when no live socket updates arrived in
  the window (heartbeat fallback), or extend the interval while the
  socket is OPEN. Keeps the approval surface identical.
- Validation: fake-timer test that no /api/runs fetch fires while the
  socket delivers events; integration check that completed runs still
  appear after stream end.

### F3 — ActivityView sorts and renders up to 1000 spine events per 5s poll (MEDIUM)
- Evidence: components/ActivityView.tsx:76-80 — [...events]
  .sort((a,b)=>b.seq-a.seq).map(...) runs on EVERY render (not memoized);
  live-status.ts:340 buffers up to MAX_SPINE_EVENTS=1000
  (packages/shared/src/events.ts:121). No windowing/virtualization.
- Caller->callee: setTimeout(reload,5_000) (ActivityView.tsx:24) ->
  useSpine fetch ?since=cursor (live-status.ts:294-360) -> setState ->
  re-render -> O(1000 log 1000) sort + up to 1000 EventRow mounts.
- Fix: useMemo the descending sort on [events]; cap visible rows or
  virtualize (render last ~200 with a show-more affordance); memo
  EventRow.
- Validation: unit test ordering preserved; profiler check on a
  synthetic 1000-event buffer.

### F4 — Parallel 10s pollers issue 2 requests/cycle, not visibility-gated (LOW-MEDIUM)
- Evidence: app.tsx:162 (GET /api/approvals) and app.tsx:201
  (GET /api/agents) both setInterval(load, 10_000). Gated on mainView
  membership (app.tsx:630,634) — good — but NOT on
  document.visibilityState; a hidden tab keeps polling at ~0.2 req/s.
  The code comment (app.tsx:130) notes the poll drives DO writes.
- Fix: pause intervals while document.hidden (revive() already catches
  up on return, app.tsx:656-684); optionally merge approvals+agents
  into one fetch.
- Validation: jsdom test toggling visibilityState asserts no fetch.

### F5 — Spine merge rebuilds a Set of up to 1000 seqs each 5s poll (LOW)
- Evidence: live-status.ts:333-340 — new Set(events.map(seq)) + concat +
  slice(-MAX_SPINE_EVENTS) per poll.
- Cost: O(1000) allocation per 5s; acceptable, but a persistent Set in
  the buffer ref removes the rebuild.
- Fix: store {seqs: Set, events: []} in the ref.
- Validation: existing cursor/rotation behavior (earliestSeq resync,
  live-status.ts:319) must still hold.

### F6 — PairingModal 1s setInterval while open (NEGLIGIBLE)
- Evidence: RemoteAccessView.tsx:38-41 — setInterval(setNow,1000) only
  while the pairing dialog is mounted; correct cleanup. No action.

### F7 — RemoteAccessView fleet poll overlaps safely but ungated (LOW)
- Evidence: RemoteAccessView.tsx:139 — setInterval(load, POLL_MS=10_000);
  latest-write-wins via createLatest (RemoteAccessView.tsx:~113); runs
  only while the view is mounted. Same visibility gap as F4.
- Optional: skip tick when document.hidden.

## Positive findings (already mitigated)
- useSpine incremental ?since= cursor avoids resending the full log
  every 5s (live-status.ts:287-340); rotation forces a bounded resync.
- Approvals poll applies only the newest response (seq guard,
  app.tsx:138-157) preventing stale repaint.
- Pollers are view-gated via enabled — no background view polling.
- visibilitychange/online revive logic exists (app.tsx:656-684).
- Heavy derived data is useMemo'd (app.tsx:637,644,1135,1186,1227;
  DashboardView.tsx:62,77; DiffViewer.tsx:44).

## Cross-lane note
- apps/desktop/approvals-poller.ts:83-105 (tray setInterval) and
  updater.ts intervals are desktop/auxiliary — flagged for worker-3's
  lane, not duplicated here.

## Fix ordering recommendation
1. F1 — memoize StepTimeline rows + tool-output serialization (biggest
   CPU win on the hot path).
2. F3 — memoized sort + row cap (bounded, cheap).
3. F2 — socket-aware retained-runs refresh (removes redundant requests).
4. F4/F7 — visibility-gate intervals (one shared helper, small diff).
5. F5 — optional allocation cleanup.

All fixes preserve the approval gate: no changes to getToolPartState,
getToolApproval, or decision flows are required.
