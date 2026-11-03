# Session room realtime

The dashboard's live chat room is keyed by the authenticated owner and the
server-registered session ID. The Worker verifies both before forwarding a
WebSocket upgrade to `ConversationRoom`. A viewer ID identifies one browser
connection; it carries no permissions by itself.

The room persists user chat messages and the current assistant stream in its
SQLite Durable Object storage. It broadcasts those writes to connected viewers
and derives presence from the attached WebSockets. Typing state is temporary
and expires after five seconds. Closing a socket removes that viewer from the
presence snapshot.

## Workspace visibility

Realtime membership does not grant access to another user's session. Shared
skill and MCP visibility stays under the existing authenticated workspace and
owner checks; a viewer joining a session room receives no new skill content,
MCP tools, or credentials through the room protocol. Stream text is the same
session transcript that the owner can already read.

Any future cross-user room sharing must check workspace membership and the
existing per-skill and per-MCP grants before exposing resource names, content,
or tool results. Presence and a room invitation are not authorization for
those resources. That broader sharing work is outside this change.
