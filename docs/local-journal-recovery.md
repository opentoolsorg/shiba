# Local journal recovery drill

This is a deterministic Linux acceptance test of the local transport and durable
room boundary. It uses the installed workerd runtime, real SQLite Durable Object
storage and an actual TCP WebSocket bound to an ephemeral `127.0.0.1` port.

Run it directly:

```sh
node --test apps/backend/test/acceptance/worker-journal-recovery.test.mjs
```

The backend Vitest suite runs the same driver through
`test/acceptance/worker-journal-recovery.test.ts`. It needs the existing installed
Wrangler, esbuild, Miniflare and workerd packages. It starts no Docker engine,
Cloudflare Container, coding CLI, model, provider integration or deployment and
requires no credential. It downloads nothing. The process-identity fixture is
Linux-specific; other platforms skip this test explicitly.

## What the test executes

The test-only Worker entry imports the production `ConversationRoom` and
`createRunJournalPublisher` without changing them. The driver starts a fixed Node
program under the production `EXECUTION_JOURNAL_SOURCE`, replacing only its
journal root with a private temporary directory. That program emits known
stdout and stderr, waits at controlled barriers, and writes a launch marker.
It is a source-process fixture, not a coding agent.

The test then:

1. Proves the outbound service denies an intentional reserved-domain probe.
   All other outbound traffic is forbidden; no business or auth metadata is read.
2. Publishes initial source frames and opens a real localhost TCP WebSocket.
   An incomplete synthetic secret remains unpublished.
3. Disconnects that viewer and disposes the actual workerd runtime. A new
   runtime opens the same SQLite persistence while the original Node supervisor
   and its immutable job/process identity remain alive.
4. Continues the same job, including a Unicode code point split across real
   source-frame boundaries, then loses both append replies after the actual
   SQLite transaction commits. The acknowledged prefix remains durable.
5. Recreates workerd a second time. The production journal adapter attaches to
   the same job without calling `START`; the launch marker remains exactly one.
   A fresh publisher finishes any unacknowledged suffix.
6. Reconnects over TCP using the earlier viewer cursor. Event IDs are unique,
   room sequences are contiguous, replay completion covers the last delivered
   sequence, and both redacted stdout/stderr SHA-256 digests match expected text.
7. Produces 2,049 separate events in an isolated second room. Its real socket
   receives the retained 2,048 events and an explicit `run:replay_gap` notice.

The driver emits a diagnostic with source-file digests, output digests, runtime
and launch counts, and the retention result. No source output or credential is
needed in that diagnostic. Each operation and the whole test have time bounds.
Cleanup closes owned sockets, disposes owned runtimes, validates a unique fixture process marker and owned workerd
PID/start identities before any fallback termination, cancels only the fixture
journal job, and removes its own temporary state. It does not use port 1040 or
terminate other sessions.

A second regression stops the fixture while its source is still at the first
barrier. Cleanup leaves the supervisor alive long enough to observe its cancel
marker, then verifies that the exact detached anchor PID/start/group/session has
exited. Any fallback termination is restricted to that captured group. Process
environment checks apply only to direct workerd children of this driver, after
checking their parent and binary; unrelated process environments are never read.

## What this evidence does not establish

The bridge from the Node supervisor to the Worker is a fixture. Production
`Sandbox` needs a real `ctx.container`; this test does not provide one. It does
not establish Cloudflare Sandbox RPC behavior, container eviction behavior,
provider egress, native user authentication, or the full
Think/CodingOrchestrator/OpenCodeAgent recovery chain. Those boundaries need
separate authorized acceptance tests. Test-only HTTP routes are not imported by
the production Worker and confer no production execution authority.

The output guarantee is bounded. Source journals allow at most 4 MiB and 4,096
frames. Room display history retains 2,048 events, so a clean but sufficiently
long disconnection can require an explicit gap notice even within source bounds.
The publisher also replaces oversized output lines with a safety notice. This
test proves complete redacted replay for its retained-window case, not universal
lossless output for every run size.

Container replacement remains separate. A process destroyed with its container
cannot be reconstructed by reconnecting. A future external journal may preserve
bytes acknowledged before replacement; it must still report any unacknowledged
tail as unknown and must not relaunch an uncertain command without fresh human
authorization. This drill makes no replacement-recovery claim.
