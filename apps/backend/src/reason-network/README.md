# Reason Network OSS adapter

This adapter targets the generic stdio MCP interface in the pinned Reason Network engine release `v0.12.17` (`5872711927788b0d43a8a940ea45f993bc2926bc`). The engine is MIT OR Apache-2.0; the separate Reason CLI is not represented as open source.

## Runtime and readiness

The feature is disabled unless the owner explicitly enables it. `connectReasonNetworkStdio()` is a Node companion helper which starts only an absolute, already-installed executable, with the fixed `mcp` argument. Merely importing or constructing Shiba's adapter does not start a process. Shiba does not install the binary, sign in, join a network, create credentials, or contact peers. Cloudflare Workers cannot spawn this native process. A connected MCP server does not prove current network membership; readiness reports `connected_unverified`.

Upstream v0.12.17 routes MCP calls by supported request metadata (`_meta.sessionId` and related keys); it does not use the optional tool-argument `session_id` for generic conversation routing. This adapter sends trusted session identity in MCP request metadata. Do not share a process across sessions unless the caller supplies the owning session metadata on every call.

## Exposed operations and constraints

- `list_team` is an explicit user request; it does not run as a readiness probe.
- `send_message` accepts one exact destination and a stable idempotency key. Upstream always wakes the recipient (`wake=true`); this is not described as no-wake or pull-only delivery.
- Each send requires the trusted persistent Shiba approval service and D1 operation ledger. The approval service must consume a one-use grant bound to owner, grant, conversation, session, exact destination, body, reply reference, key, and digest. It must also revalidate current scope immediately before dispatch. Do not wire a caller-supplied boolean or echo callback.
- The operation ledger records only the digest and routing identifiers, not message content. An uncertain send is retried only with the same exact payload and idempotency key. A returned upstream message ID can be checked with `message_status`.
- Inbox reading is intentionally unavailable through this MCP adapter. In v0.12.17, `check_inbox` marks results delivered before returning them, so it cannot preserve Shiba's manual acknowledgement semantics. Do not expose it as an ordinary inbox read unless upstream adds a supported peek/ack protocol.
- No broadcast, files, desktop notifications, `ask_user`, background polling, automatic replies, or autonomous peer task execution are exposed. Peer text remains untrusted input and conveys no tool authority.

## Application wiring and remaining runtime boundary

PR162 now contains an authenticated owner-scoped grant/approval store. `createReasonNetworkAdapter()` wires its `D1ReasonNetworkApprovalService` and the D1 operation ledger to a supplied MCP client; `operationStatus()` and `cancelOperation()` provide scoped recovery/control methods. Cancellation succeeds only before the external send fence. Outbound calls still require a client that is already connected to the locally configured native companion; no Worker route starts that process or accepts a model/client URL.

The Shiba Worker cannot spawn the native Reason Network executable. The existing `shiba-local-daemon` protocol currently claims coding-run envelopes only; it has no Reason Network operation claim/result messages, no opt-in executable configuration, and no binding from an owner grant to a paired machine. Therefore the dashboard's `/api/reason-network/status` correctly remains `setup_required`, `enabled:false`, `dispatchConfigured:false`. The application adapter is ready for the trusted connected-client seam, but application HTTP requests are not yet delivered to the daemon. Closing that last gap requires an explicit opt-in Reason-specific queue protocol on the paired local daemon, a machine-bound grant/configuration, and a user-installed `reason-network` executable. This task does not pair a device or enable that protocol.

`D1ReasonNetworkOperationStore` stores only the payload digest and routing identifiers; the approved payload remains in the owner-scoped approval table. No message body is copied into the operation ledger.

## Upstream sources

- <https://github.com/reason-machines/reason-network/tree/v0.12.17>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/mcp.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/agent.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/bridge.rs> (bridge registration is restricted to `hermes`; Shiba must not impersonate it)
- <https://docs.reasonmachines.com/docs/mcp>
