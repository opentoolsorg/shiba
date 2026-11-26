# 0004 — The thread is a canonical event log in a per-thread DO

## Context

Slack, the web app and the desktop app each keep their own message state; there
is no shared model, and `apps/backend/src/v1-message-queue.ts` approximates a
queue with KV read-modify-write, which loses writes by design because KV is
eventually consistent. `ConversationRoom`
(`apps/backend/src/conversation-room-do.ts`) already holds per-conversation
state with hibernatable WebSockets (`acceptWebSocket`, `serializeAttachment`),
keyed per run (`ownerId` + `sessionId`) or per collaboration room.

## Options

- **(a) D1 `events` table plus polling** — loses: polling does not give live
  multiplayer, and D1 is the wrong home for a high-write ordered log.
- **(b) One DO per workspace for all events** — loses: it serializes every
  message of every thread, making a hot spot exactly where the multiplayer pitch
  is.
- **(c) A DO per thread, grown out of `ConversationRoom`** — chosen.

## Decision

(c). The thread is an ordered event log in its own Durable Object. DO class
names are kept (`ConversationRoom` stays `ConversationRoom`; renaming needs a
`renamed_classes` migration and buys nothing). The DO gains `events`
(gapless `seq`, `UNIQUE(idem_key)`), `bindings` and `outbox` tables plus a
`schema_version`. The event envelope and per-type zod schemas live in
`packages/shared/src/`; a D1 `threads` projection serves lists and search.
Duplicate appends return the existing `seq`; webhook routes ack fast and
enqueue, with dedupe enforced only at the DO — the one strongly consistent
place.

## Consequences

- Listing and searching across threads needs the D1 projection; each open
  thread costs one socket.
- Reversal cost: medium. Events are append-only and can be exported to D1.
