# 0005 — Workspace DO for presence and the feed; WebSockets replace desktop polling

## Context

`WorkspaceEvents` already exists and is keyed by workspace
(`workspaceEventsName()` in `apps/backend/src/platform/workspace-events-do.ts`,
resolved with `getByName`), and it already speaks hibernatable WebSockets with
`serializeAttachment` socket metadata. The desktop app instead polls approvals
through `apps/desktop/src/approvals-poller.ts`, and the frontend keeps several
realtime stores (`apps/frontend/src/conversation-room-realtime.ts`,
`apps/frontend/src/collaboration-room-realtime.ts`,
`apps/frontend/src/state/workspace-events.ts`).

## Options

- **(a) Keep polling** — loses: latency and wasted requests; the desktop app
  stops being realtime.
- **(b) SSE** — loses: no native bidirectional channel for typing indicators
  and viewer reports back to the DOs.
- **(c) Hibernatable WebSockets, which already exist** — chosen, plus a poll
  fallback for one release.

## Decision

(c). Two levels, not one: the **workspace DO** carries the feed (thread list
changes, pending approvals, run status summaries) under its own `feedSeq`,
with the last ~1,000 entries kept in DO SQLite, plus ephemeral presence
(`{memberId, surface, viewingThreadId?, state, lastSeen}` in socket
attachments). Each **thread DO** carries full events, typing indicators and
"employee is working" status for each open thread view, and reports its viewers
to the workspace DO. Reconnect uses `{type:"resume", since}`; inside the
retained window the DO replays `seq > since` (up to 500), otherwise the client
gets `{type:"reset"}` and re-snapshots over HTTP. The desktop app is the same
SPA (`apps/frontend/src/desktop-provider.ts`,
`apps/frontend/src/desktop-status.ts`) plus native tray/notifications/
LocalDispatch pairing; `approvals-poller.ts` stays one release behind
`SHIBA_DESKTOP_POLL_FALLBACK`, then is deleted.

## Consequences

- Reconnect and backfill logic lives in the client; presence is ephemeral and
  never persisted beyond socket attachments (ids and state enum only, ~2 KiB).
- Reversal cost: low — clients can fall back to fetching.
