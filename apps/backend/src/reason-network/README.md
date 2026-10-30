# Reason Network OSS adapter

This adapter targets the generic stdio MCP interface in the pinned Reason Network engine release `v0.12.17` (`5872711927788b0d43a8a940ea45f993bc2926bc`). The engine is MIT OR Apache-2.0; the separate Reason CLI is not represented as open source.

## Runtime and readiness

The feature is disabled by default. The Worker requires `REASON_NETWORK_ENABLED=1`, `SHIBA_LOCAL_RUNTIME=1`, and the existing paired-machine `PAIRING_SECRET`. A paired daemon reports `reasonNetworkCompanion:true` only when its explicit `SHIBA_REASON_NETWORK_COMPANION=1` opt-in and absolute `SHIBA_REASON_NETWORK_EXECUTABLE` path are present. Readiness and grant creation require an online paired machine reporting that capability. The daemon starts the executable only after claiming an approved operation. Merely importing the adapter or running the daemon without the opt-in starts no Reason process. Shiba does not install the binary, sign in, join a network, or create credentials. Cloudflare Workers cannot spawn this native process. A connected MCP server does not prove current network membership; readiness reports the configured state without probing membership.

Upstream v0.12.17 routes MCP calls by supported request metadata (`_meta.sessionId` and related keys); it does not use the optional tool-argument `session_id` for generic conversation routing. This adapter sends trusted session identity in MCP request metadata. Do not share a process across sessions unless the caller supplies the owning session metadata on every call.

## Exposed operations and constraints

- Team directory lookup is not exposed in the current Shiba UI or application API.
- `send_message` accepts one exact destination and a stable idempotency key. Upstream always wakes the recipient (`wake=true`); this is not described as no-wake or pull-only delivery.
- Each send starts from an authenticated approval ID and uses the existing one-use D1 approval store. Its operation record binds owner, grant, conversation, session, paired machine, exact payload digest, approval ID, and stable idempotency key. The message body stays in the approval record. The Worker queues only that stored payload; it ignores caller-supplied message fields when enqueueing.
- The private `/api/local/reason-network/v1/*` companion protocol is behind existing paired-machine bearer authentication. Claims are machine-bound and single-writer; result writes require the server-minted claim token. Cancellation before claim prevents dispatch; cancellation is rechecked after MCP setup immediately before send and may be too late once a send is in flight. Stale claimed operations become `unknown`; owner recovery requeues only the same consumed approval and idempotency key, and only within six days of the immutable first claim time. Upstream v0.12.17 retains idempotency keys for seven days, so after this conservative window an unknown result stays unknown and needs a new reviewed send decision. Legacy unknown rows migrated without an original first-attempt timestamp are not replayable. Grant revocation blocks new claims and recovery.
- The operation ledger records only the digest and routing identifiers, not message content. An uncertain send is retried only with the same exact payload and idempotency key. A returned upstream message ID can be checked with `message_status`.
- Inbox reading is intentionally unavailable through this MCP adapter. In v0.12.17, `check_inbox` marks results delivered before returning them, so it cannot preserve Shiba's manual acknowledgement semantics. Do not expose it as an ordinary inbox read unless upstream adds a supported peek/ack protocol.
- No broadcast, files, desktop notifications, `ask_user`, background polling, automatic replies, or autonomous peer task execution are exposed. Peer text remains untrusted input and conveys no tool authority.

## Application and operator flow

The authenticated `/api/reason-network/v1/operations` endpoint accepts an approved `approvalId`, persists an operation, and exposes owner-scoped status, cancellation, and time-bounded same-key recovery. The paired daemon claims only operations bound to its machine, reports capability on every heartbeat (including `false` when opt-in is off or the executable disappears), and sends the immutable approved payload through upstream `send_message` with MCP `_meta.sessionId`. It rechecks the claim after MCP initialization and tool discovery immediately before sending. No endpoint accepts a caller-supplied URL or arbitrary payload at dispatch time. `D1ReasonNetworkOperationStore` stores the digest and routing identifiers, not the body.

Operator activation is still manual: pair the local daemon through the existing Shiba Remote Access flow, set the Worker flags/secrets above, configure the daemon opt-in and executable path, wait for its heartbeat to show Reason companion capability, create a grant for that paired machine and exact conversation/session, and configure/join the upstream Reason Network yourself. This change does not pair a device, install/run the upstream binary, join a network, or contact peers. The upstream tool always wakes the recipient. Inbox reading remains unavailable because upstream `check_inbox` acknowledges before returning.

## Upstream sources

- <https://github.com/reason-machines/reason-network/tree/v0.12.17>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/mcp.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/agent.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/store.rs> (idempotency-key retention)
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/bridge.rs> (bridge registration is restricted to `hermes`; Shiba must not impersonate it)
- <https://docs.reasonmachines.com/docs/mcp>
