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

## Integration blocker

PR162 contains pure connection-policy decision primitives and a generic capability invocation ledger, but no persistent employee-policy approval service. The adapter therefore accepts an explicit `ReasonNetworkApprovalService` integration contract and fails closed if it is absent. The PR owner must implement that interface using the trusted persistent policy/approval store before enabling outbound sends. `D1ReasonNetworkOperationStore` uses the existing `AGENT_AUDIT` D1 binding.

## Upstream sources

- <https://github.com/reason-machines/reason-network/tree/v0.12.17>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/mcp.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/agent.rs>
- <https://github.com/reason-machines/reason-network/blob/v0.12.17/src/bridge.rs> (bridge registration is restricted to `hermes`; Shiba must not impersonate it)
- <https://docs.reasonmachines.com/docs/mcp>
