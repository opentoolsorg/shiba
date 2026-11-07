# Multiplayer backend acceptance — 2026-11-06

## Outcome and scope

The independent multiplayer acceptance workstream reported **98 passing tests
across seven existing suites** at commit
`293d895346788a2c84d45009c3612708fbe3102f`. The coordinator confirmed the same
base revision and inspected the referenced authentication/realtime boundaries.
The coordinator also independently passed the first three suites below (20 tests).
No missing access or revocation boundary warranted a new backend regression file;
no application code or existing tests changed in this workstream.

The separate checkout did not contain the coordinator's uncommitted frontend
launchpad or canonical-link changes. This report does not verify those changes.
Checks used Node 24.22.2, pnpm 10.34.4, and Vitest 5.0.1 on November 6 UTC.

## Reproduce

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

The independent workstream reported both commands exited 0: 7.48 seconds starting
06:29:59 UTC and 5.62 seconds starting 06:30:30 UTC. OXC taking precedence over
configured esbuild JSX options was a warning, not a failure or skipped test.

## Established boundaries

- **Independent identities and explicit grants:** the room-auth suite uses real
  Better Auth handlers, signed cookies, and in-memory SQLite through a D1 adapter.
  Distinct owner/teammate sessions accept an invitation; workspace membership alone
  yields 404 for the room until an explicit room grant. Shared messages retain
  the authenticated teammate's attribution. Realtime forwarding uses distinct
  server-derived viewer IDs despite identical client nonces. Forged identity
  headers do not replace session identity. Removing the teammate denies its room
  read while preserving the owner's access.
- **Workspace isolation:** scope suites reject duplicate, malformed, conflicting,
  and foreign workspace selectors without personal/base-owner fallback. Workspace
  roles do not replace human room grants. Team messages, notes, writes, and
  employee profiles remain workspace-scoped.
- **Presence authority:** `ConversationRoom` tests derive identity from
  server-owned attachments, reject spoofed frames, bound cursors, and separate
  presence from chat/execution/approval/replay writes. Accepted durable writes
  emit refresh hints without message bodies.
- **Selected context:** context and memory suites freeze only selected room
  messages/notes with exact authors, versions, and hashes. Empty selection adds no
  implicit history. Foreign, duplicate, changed, revoked, or racing selections
  fail approval-bound checks. Explicit room sources are not merged private memory.
- **Removal:** workspace removal denies reads, message writes, note reads, and
  handoff cancellation; pending handoffs become non-dispatchable. A stale room
  grant does not override removed workspace membership. Removed sockets close
  with code 1008 and receive no subsequent presence/refresh frames. Idle cleanup
  is covered by an alarm after Durable Object reconstruction.
- **Retained output:** live-route tests deny outsiders before consulting execution
  output and recheck membership, selected sources, cancellation, scope, and
  run-input proof after awaited reads. Workspace/executor pins prohibit owner
  fallback; replay is bounded and run-scoped.

The inspected `collaboration-room-routes.ts` and `collaboration-room-access.ts`
check current workspace/room grants before forwarding and rebuild actor/viewer
headers server-side, with authority rechecked before forwarding.

## Limits

**This is local fixture proof, not live production multiplayer acceptance.**
The cookie fixture seeds the teammate's verified account and invitation provenance
locally and reuses a fixture password hash. It does not prove real mailbox
verification, native signup, or two production accounts. Its realtime binding
records requests and returns 200, not a real WebSocket handshake.

Other suites mock authentication or runtime boundaries; D1, sockets, executors,
and replay use local adapters. No deployed Worker, network socket pair, browser
presence rendering, production D1 consistency, or revocation latency was measured.
Socket removal is proved on send/delivery/notification/alarm paths, not as
instantaneous global revocation. Post-removal write and socket denial are proved
separately from the real-cookie read test.

No production accounts, credentials, external mutations, deployments, PRs, or
auto-merge were used. The coordinator owns final integration gates. The supported
inherited model was used; Luna Max and DeepSeek were not selected or claimed.
