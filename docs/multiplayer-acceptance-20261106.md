# Multiplayer backend acceptance — 2026-11-06

## Outcome and scope

**Local backend acceptance passed: 98 tests across seven existing suites.**
The five requested suites account for 75 tests; two additional existing suites
establish the selected-context contract directly (23 tests). No concrete missing
revocation/access boundary was found in this bounded audit that warranted a new
regression file. No application code or existing tests were changed.

Evidence was collected against commit
`293d895346788a2c84d45009c3612708fbe3102f` in a clean checkout before this document.
The parent coordinator's uncommitted frontend launchpad/canonical-link changes
were not present and are not verified by this report. Node `v24.22.2`, pnpm
`10.34.4`, and repository Vitest `5.0.1` ran the checks on 2026-11-06 UTC.

## Reproduce and results

```sh
pnpm -C apps/backend test \
  test/collaboration-room-auth.test.ts \
  test/collaboration-team-scope.test.ts \
  test/team-collaboration-scope.test.ts \
  test/collaboration-live-routes.test.ts \
  test/collaboration-room-realtime.test.ts

pnpm -C apps/backend test \
  test/collaboration-context.test.ts \
  test/collaboration-memory.test.ts
```

| Suite (`apps/backend/test/`) | Passed |
| --- | ---: |
| `collaboration-room-auth.test.ts` | 1 |
| `collaboration-team-scope.test.ts` | 9 |
| `team-collaboration-scope.test.ts` | 10 |
| `collaboration-live-routes.test.ts` | 39 |
| `collaboration-room-realtime.test.ts` | 16 |
| `collaboration-context.test.ts` | 13 |
| `collaboration-memory.test.ts` | 10 |

Both commands exited 0: first run 7.48 seconds (06:29:59 UTC), second 5.62
seconds (06:30:30 UTC). Vitest warned that OXC takes precedence over the configured
esbuild JSX options; neither run failed or skipped tests.

## What the checks establish

### Independent authenticated members and explicit grants

`collaboration-room-auth.test.ts` uses actual Better Auth handlers and signed
cookies backed by in-memory SQLite through a D1 adapter. The owner creates a
workspace and invitation. An independently identified teammate signs in with a
distinct cookie and accepts that invitation. Workspace membership alone gives
404 for the room; an explicit human room grant is required before posting succeeds.
The owner's subsequent room read contains the teammate's attributed message.
Both cookie sessions route to realtime with their authenticated actor identities
and different server-derived viewer IDs even when given the same viewer nonce.
A forged Access identity header does not replace cookie identity, and an identity
header without a valid session yields 401. After room removal the teammate's room
read is 404 while the owner's read remains 200.

This fixture inserts the teammate's verified account/invitation provenance locally
and reuses the fixture password hash. It does **not** exercise independent mailbox
verification, native invitation signup, or two independently provisioned production
accounts. The realtime binding only records forwarded requests and returns 200;
that status is not proof of a real WebSocket handshake.

### Workspace selection and isolation

`team-collaboration-scope.test.ts` checks authenticated identity normalization,
matching header/query selectors, and current workspace membership. Duplicate,
malformed, conflicting, and foreign selectors fail closed without default
fallback. A workspace role label cannot replace a current human room grant.
`collaboration-team-scope.test.ts` exercises attributed shared messages/notes,
personal/team separation, outsider denial, cross-workspace write denial, and
team-specific employee profile scope. These suites mock request authentication;
they prove policy/store behavior, not the external login boundary.

### Live identities, presence, and socket authority

`collaboration-room-realtime.test.ts` drives `ConversationRoom` with local socket
and Durable Object storage fixtures. Presence labels and viewer identities come
from server-owned attachments, not spoofed frame fields. Normalized cursors are
shared with authorized peers; malformed frames, excessive movement, and stale
cursors are handled. Presence does not write chat or run-event records. Clients
cannot turn this channel into message submission, execution, approval, replay
subscription, or forged server events. Accepted durable HTTP writes emit a room
refresh hint without the message body.

### Selected context, not implicit shared private memory

The additional `collaboration-context.test.ts` run directly proves that freezing
context includes only selected room messages/notes with exact authors, versions,
and hashes, excluding unselected conversation and private-room history. Empty
selection adds no implicit context. Forged, foreign-room, duplicate, changed, or
revoked selections fail the approval-bound authority checks.
`collaboration-memory.test.ts` covers immutable provenance, current member recall,
revocation authority, hashing-time membership/revocation races, and bounds.
These are persisted explicit room sources, not a merged private transcript or
shared JavaScript heap.

### Removal and subsequent read/write/socket denial

- **Workspace removal:** `collaboration-team-scope.test.ts` removes a member through
  `changeTeamWorkspaceMember`; subsequent room reads, message writes, note reads,
  and handoff cancellation return 404. Existing pending handoffs become cancelled
  and non-dispatchable. A separate stale-grant fixture leaves room membership
  active after workspace removal and proves store reads/writes still fail closed,
  including absence of the rejected message in storage.
- **Room/socket removal:** realtime tests reject unauthenticated, foreign-origin,
  outsider, and removed-member upgrades, then independently recheck the grant
  inside the DO. Existing removed sockets close with code 1008 and receive no
  further presence/refresh frames. A removed sender cannot deliver cursor frames.
  Tests also revoke workspace membership while leaving a room grant active, and
  exercise idle-socket cleanup through an alarm after object reconstruction.
- **Retained output:** live-route tests reject outsiders/removed room members
  before consulting the executor or journal. They recheck room membership, selected
  source revocation, handoff cancellation, scope authority, and run-input proof
  after awaited reads, returning no approved output if authority changed. Team
  tests enforce exact workspace/executor pins with no base-owner fallback. Replay
  is bounded and run-scoped; other-run frames fail rather than partially leak.

The actual route/access implementations were inspected in
`collaboration-room-routes.ts` and `collaboration-room-access.ts`: checked scope
and current room/workspace grants precede forwarding, actor/viewer headers are
rebuilt server-side, and scope/access are checked again before forwarding.

## Limits and handoff

This is **local fixture proof, not live production multiplayer acceptance**.
The Node Vitest configuration aliases Cloudflare runtime modules; D1, socket,
executor, and replay boundaries are local adapters or mocks. No deployed Worker,
network WebSocket pair, browser presence rendering, real email delivery, production
D1 consistency, or revocation latency was measured. Socket cleanup is demonstrated
on send/delivery/notification/alarm paths, not as instantaneous global revocation.
The real-cookie test does not itself chain post-removal write and socket denial;
those boundaries are established separately by the policy/realtime suites above.

No production accounts, credentials, external mutations, deployment, PR, or
automerge were used. Full monorepo gates were not run in this bounded backend
acceptance workstream; the parent must apply its integration gates to its own
frontend changes. This document and no regression file are the integration payload.
The supported inherited default model was used; no Luna Max/DeepSeek route was
selected or claimed.

Parent coordinator: `thr_0ccfb90cac0046cc9ea7a913fa511a12`. Direct `other_thread_control send_message`
handoff is unavailable in this thread's advertised tool surface (only rename,
Linear linking, and Slack disconnection operations are exposed). Conclusions are
therefore recorded here and in the task's final response for coordinator pickup;
no alternate API or shell bypass was attempted.
