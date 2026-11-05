# Control plane reference audit

Audit date: 2026-11-03. Shiba baseline: `be13d0bbb752dce6bf5b645bfb0fa33676804ad1`.

The later user specification supersedes the earlier specification. This document records verified upstream patterns and baseline gaps. It is not evidence that a feature has passed a live cloud acceptance run. No third party implementation source was copied into Shiba for this audit.

## Cloudflare Agents

Verified revision: `455b47ec93f99f306f644ac06bc8b72b0627c1fc`. The repository uses the [MIT license](https://github.com/cloudflare/agents/blob/455b47ec93f99f306f644ac06bc8b72b0627c1fc/LICENSE).

The current [official subagent documentation](https://developers.cloudflare.com/agents/agent-class/sub-agents/) documents colocated child Durable Objects with separate SQLite storage. It documents `subAgent(ChildClass, name)`, typed child RPC, nested facets, and parent routing through `onBeforeSubAgent`. Child classes must be exported under their exact class names. Classes used only as facets do not require separate production namespace bindings or migrations.

The stronger claim that a facet is a security boundary, or that every child shares the parent's address space, is unsupported. The pinned [Agent implementation](https://github.com/cloudflare/agents/blob/455b47ec93f99f306f644ac06bc8b72b0627c1fc/packages/agents/src/index.ts) describes dynamic agents with their own isolates and SQLite databases. Colocation is not a substitute for explicit capability restrictions. No zero latency guarantee is assumed.

The pinned [agent tool implementation](https://github.com/cloudflare/agents/blob/455b47ec93f99f306f644ac06bc8b72b0627c1fc/packages/agents/src/agent-tools.ts) constructs an AI SDK tool that calls the current agent's `runAgentTool`. Stable tool call IDs become stable run IDs. Completed runs return validated structured output when an output schema is supplied; errors, interruptions, and cancellation return structured failure values.

The pinned [agent tool guide](https://github.com/cloudflare/agents/blob/455b47ec93f99f306f644ac06bc8b72b0627c1fc/docs/agents/agent-tools.md) documents child event frames, replay, cancellation, retained runs, explicit cleanup, and `useAgentToolEvents`. It explicitly recommends checking `hasAgentToolRun` inside `onBeforeSubAgent`, so a guessed child URL cannot create a new facet. Child public RPC methods and direct chat routes must still be restricted by Shiba.

SDK stream recovery covers the SDK's persisted child message protocol. It does not automatically persist or replay arbitrary container stdout, stderr, file diffs, or Shiba room messages. Those streams need their own authenticated ingress, durable sequence numbers, replay cursors, and an explicit response when retained history no longer covers a cursor. Exactly once external effects are not inferred from replay support. The guide requires idempotent completion handlers after a crash.

The runtime supports nesting. Shiba's depth limit of one, child tool allowlists, execution time limits, concurrency limits, approval checks, and isolated workspace requirements must therefore be enforced by Shiba rather than assumed from the SDK.

## Overlay

Verified revision: `771afc840ea0a32ccfae864ce16a46554a8d89af`. The repository includes the [GNU AGPL version 3 license](https://github.com/LayerNorm/overlay-web/blob/771afc840ea0a32ccfae864ce16a46554a8d89af/LICENSE) and a separate commercial licensing document. No commercial license is assumed.

The [Slack reply implementation](https://github.com/LayerNorm/overlay-web/blob/771afc840ea0a32ccfae864ce16a46554a8d89af/src/server/surfaces/slack-reply.ts) resolves a bot token from the specific team installation, sets the agent's `username` on a threaded `chat.postMessage`, and can edit an existing working message using `chat.update`. Missing or revoked installation credentials cause a degraded connection result.

The [Slack app manifest documentation](https://github.com/LayerNorm/overlay-web/blob/771afc840ea0a32ccfae864ce16a46554a8d89af/internal/develop/surfaces-slack-app.md) includes `chat:write.customize`, `assistant:write`, and the `agent_view` feature. The [OAuth implementation](https://github.com/LayerNorm/overlay-web/blob/771afc840ea0a32ccfae864ce16a46554a8d89af/src/server/surfaces/slack-oauth.ts) requests the customization scope.

`agent_view` is an app messaging experience configured through the Slack manifest. It is not a standalone status API. Slack's [agent development guide](https://docs.slack.dev/ai/developing-agents/) describes the feature and the separate assistant thread APIs. The [message API documentation](https://docs.slack.dev/reference/methods/chat.postMessage/) documents `username`, `icon_url`, and `icon_emoji` customization and its scope requirement. Persona names are presentation only and confer no approval authority.

The portable pattern is one installation credential selected by workspace plus explicit specialist display names and a stable status message. Shiba must retain signature verification, workspace checks, approver allowlists, and server owned action IDs.

## T3 Code

Verified revision: `b7ab02e0f6077a72cadfa5c9a40db4db67bc325f`. The project uses the [MIT license](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/LICENSE).

The [orchestration overview](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/docs/orchestration-v2/README.md) distinguishes commands, durable normalized events, graph state, projections, and effects. It warns against replacing the established event infrastructure with an unrelated bus. Its outbox discussion is a design history; the pinned tree also contains an implemented [effect outbox](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/apps/server/src/orchestration-v2/EffectOutbox.ts), an [event store](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/apps/server/src/orchestration-v2/EventStore.ts), and a pure [guest command decider](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/apps/server/src/orchestration-v2/GuestShareDecider.ts).

The actual implementation is a larger orchestration service rather than one universal pure decider function. Shiba already has its own validated event log, pure run decider and projector, and effect outbox. New lifecycle events should extend those contracts and preserve event order and idempotency.

The [delegation tool](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/apps/server/src/mcp/toolkits/orchestrator/tools.ts) exposes `delegate_task` with explicit task context and optional worktree isolation. The [service implementation](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/apps/server/src/mcp/OrchestratorMcpService.ts) checks that the caller owns an active parent run, creates an application owned child run and thread, retains a task ID, and supports cancellation and bounded waits. The [lineage guide](https://github.com/pingdotgg/t3code/blob/b7ab02e0f6077a72cadfa5c9a40db4db67bc325f/docs/orchestration-v2/thread-lineage-and-context-transfer.md) distinguishes application owned delegation from provider native children and models completion as an explicit context transfer.

Shiba's stricter rule that a child can never approve an external mutation is a local security requirement. It is not established merely by using T3's tool names or architecture. An approval request returned by a child is an observation for a human, not approval evidence.

## Junior

The supplied `PranavBakre/Junior` reference returned GitHub HTTP 404 on 2026-11-03. Its current source, license, persona model, and message buffering behavior could not be verified. No implementation or license claim is based on this repository. The requested Shiba persona names and durable message queue are user requirements independently of this unavailable reference.

## Baudbot

Verified revision: `4a2dfacfd34c9ce98ddbe2b879a0c33734eb14c1`. The repository uses the [MIT license](https://github.com/modem-dev/baudbot/blob/4a2dfacfd34c9ce98ddbe2b879a0c33734eb14c1/LICENSE).

The [README](https://github.com/modem-dev/baudbot/blob/4a2dfacfd34c9ce98ddbe2b879a0c33734eb14c1/README.md) documents a persistent Linux control agent with task scoped development workers in separate worktrees. The [team workflow](https://github.com/modem-dev/baudbot/blob/4a2dfacfd34c9ce98ddbe2b879a0c33734eb14c1/docs/team-workflow.md) keeps progress and completion in the originating Slack thread. The [Slack bridge](https://github.com/modem-dev/baudbot/blob/4a2dfacfd34c9ce98ddbe2b879a0c33734eb14c1/gateway-bridge/bridge.mjs) serializes calls through a promise queue and attributes incoming messages to their sender.

This verifies the coordinator and worker ownership split and serialized turn intake. It does not establish that a volatile promise queue survives a process restart. Shiba's message buffer must be in durable storage. The reviewed source does not establish the exact proposed checkbox card format or commit trailer guarantee; those remain Shiba requirements if implemented.

## Open Inspect

The supplied `ColeMurray/background-agents` URL redirects to `open-inspect/background-agents`. Verified revision: `cd63f81c9bd6e7992fa61abda9b595e1c0138f8a`. The project uses the [MIT license](https://github.com/open-inspect/background-agents/blob/cd63f81c9bd6e7992fa61abda9b595e1c0138f8a/LICENSE).

The [README architecture](https://github.com/open-inspect/background-agents/blob/cd63f81c9bd6e7992fa61abda9b595e1c0138f8a/README.md) separates a session control plane from the sandbox supervisor, harness, and bridge. Its [WebSocket manager](https://github.com/open-inspect/background-agents/blob/cd63f81c9bd6e7992fa61abda9b595e1c0138f8a/packages/control-plane/src/session/websocket-manager.ts) persists the authoritative sandbox socket identity, fences replaced sockets, and tracks browser authorization leases. The [presence service](https://github.com/open-inspect/background-agents/blob/cd63f81c9bd6e7992fa61abda9b595e1c0138f8a/packages/control-plane/src/session/presence-service.ts) broadcasts participant updates.

These are useful lifecycle and authenticated hub patterns. The exact claim that this upstream stores viewer identity through `serializeAttachment` is not established by the reviewed manager; it uses persisted mappings and socket tags. Shiba can use Durable Object attachments, but must validate and restore them after hibernation and derive identity from authentication rather than a client message.

Do not copy its [sandbox environment builder](https://github.com/open-inspect/background-agents/blob/cd63f81c9bd6e7992fa61abda9b595e1c0138f8a/packages/control-plane/src/sandbox/sandbox-env.ts) wholesale. It includes user secret values in sandbox environment maps, and image build flows may carry clone credentials. That conflicts with Shiba's provider secret boundary. A WebSocket hub must not introduce a new token delivery channel into containers.

## Nehemiah

Verified revision: `fea6f0a5299154cb40da9f302a51547e61d40076`. The project uses the [Apache license version 2.0](https://github.com/boringcomputers/nehemiah/blob/fea6f0a5299154cb40da9f302a51547e61d40076/LICENSE).

The [README](https://github.com/boringcomputers/nehemiah/blob/fea6f0a5299154cb40da9f302a51547e61d40076/README.md) describes Firecracker microVMs, a Go host daemon, signed bare metal host provisioning, forks, persistent volumes, and default TTL shutdown. It is not a Cloudflare Sandbox implementation. Its fork and TTL model can inform lifecycle decisions, but its machine timing numbers and host security model cannot be presented as Cloudflare guarantees. The reviewed source does not establish Shiba's placeholder provider token model.

## Agent Client Protocol

The supplied `zed-industries/agent-client-protocol` URL redirects to `agentclientprotocol/agent-client-protocol`. Verified revision: `0e486bcd6a5ec97bcb31bc97c360996f7f2dc6a7`. The project uses the [Apache license version 2.0](https://github.com/agentclientprotocol/agent-client-protocol/blob/0e486bcd6a5ec97bcb31bc97c360996f7f2dc6a7/LICENSE).

The [README](https://github.com/agentclientprotocol/agent-client-protocol/blob/0e486bcd6a5ec97bcb31bc97c360996f7f2dc6a7/README.md) identifies stable wire protocol version one independently of SDK artifact versions. The [prompt lifecycle](https://github.com/agentclientprotocol/agent-client-protocol/blob/0e486bcd6a5ec97bcb31bc97c360996f7f2dc6a7/docs/protocol/v1/prompt-turn.mdx) uses initialization and session setup, `session/prompt`, streamed `session/update`, terminal stop reasons, and cancellation. [Tool calls](https://github.com/agentclientprotocol/agent-client-protocol/blob/0e486bcd6a5ec97bcb31bc97c360996f7f2dc6a7/docs/protocol/v1/tool-calls.mdx) have correlated IDs and permission request messages.

ACP standardizes transport and request semantics. It does not grant authority to approve a tool call, isolate a process, redact secrets, or guarantee the policy behavior of a harness. Shiba must keep its own approval and egress boundaries around ACP adapters.

## E2B

Verified revision: `fd72526782d379cbb8ee71c3297bfb2ce3be82ce`. The repository uses the [Apache license version 2.0](https://github.com/e2b-dev/E2B/blob/fd72526782d379cbb8ee71c3297bfb2ce3be82ce/LICENSE).

The [README](https://github.com/e2b-dev/E2B/blob/fd72526782d379cbb8ee71c3297bfb2ce3be82ce/README.md) creates a sandbox without a repository argument. The [sandbox API](https://github.com/e2b-dev/E2B/blob/fd72526782d379cbb8ee71c3297bfb2ce3be82ce/packages/js-sdk/src/sandbox/index.ts) supports a default base template, lifecycle operations, and upload and download URLs. The [filesystem API](https://github.com/e2b-dev/E2B/blob/fd72526782d379cbb8ee71c3297bfb2ce3be82ce/packages/js-sdk/src/sandbox/filesystem/index.ts) supports file reads, writes, binary data, and streams.

This supports separating workspace creation from Git checkout and treating artifacts as files. It does not provide a Cloudflare R2 ZIP pipeline or a seven day signed R2 capability. Those must be implemented and tested in Shiba with explicit bounds and authentication.

## OpenHands

The supplied `all-hands-ai/OpenHands` URL redirects to `OpenHands/OpenHands`. Verified revision: `b623234b91dfcdda7be5d569e0eea8b17c41251a`. The current repository uses the [MIT license](https://github.com/OpenHands/OpenHands/blob/b623234b91dfcdda7be5d569e0eea8b17c41251a/LICENSE).

The [current README](https://github.com/OpenHands/OpenHands/blob/b623234b91dfcdda7be5d569e0eea8b17c41251a/README.md) describes Agent Canvas with local, Docker, remote, cloud, and ACP compatible backends, including separate containers per conversation. It is not the historical Python runtime described in some older articles. The portable pattern is a conversation owning its execution environment independently of a GitHub repository URL. The reviewed source does not establish a ready made ZIP and R2 export pipeline.

## Shiba baseline security findings

The following are baseline findings at `be13d0b`. Later implementation changes should be checked against them.

1. `AGENTS.md` requires approval of frozen input before any sandbox starts. It also requires provider and subscription credentials to remain in Worker egress, and GitHub credentials to remain scoped to the approved repository.
2. `child-dispatch.ts` is an existing HMAC authorization envelope for child execution. It is not an empty delegation module. Preserve and strengthen its authorization checks when introducing specialist tools.
3. `approval-resolve-auth.ts` accepts approval decisions whose `decidedBy` starts with `automation:`. `authorizeAutomationRun` can return `requiresApproval: false` for opted in PR only automations. `automation-runner.ts` then resolves the approval itself. This conflicts with the later specification's ban on unattended self approval, even though the earlier implementation treated a PR as reversible. The allowlisted automatic resolution must be removed or refused.
4. `packages/shared/src/subagent.ts` allows nesting depth three and shared containers. Both `den/spawn.ts` and the older `captain/spawn.ts` can reuse a parent's budget approval and accept a child publish request. Enforcing depth one only in a new tool is insufficient. All active spawn and dispatch paths need the same isolated workspace and external write boundary.
5. The orchestrator's baseline `onBeforeSubAgent` checks retained `OpenCodeAgent` runs only. New specialist classes need the same registry check, and unknown child classes and nested routes need explicit denial. A read only specialist must not expose arbitrary chat or mutation RPC through a direct child route.
6. Existing artifact workspace runs already omit a GitHub clone and persist bounded text outputs privately. Extending them with empty and binary file support must not bypass size, path, ownership, or secret leakage checks.
7. Existing conversation rooms already support owner scoped presence and client assistant stream replay. Container output needs authenticated backend ingestion, independent durable ordering, and reconnect tests. A browser must not be able to forge terminal output or author identity.
8. Existing Slack approval ingress validates signatures and approver allowlists. Persona changes and status messages must leave unauthorized approval clicks with no run or approval side effects. Requested denial feedback is an ephemeral Slack response.

## Existing deployment failure

Main's [deployment run 41679318599](https://github.com/opentoolsorg/shiba/actions/runs/41679318599) ran against `be13d0bbb752dce6bf5b645bfb0fa33676804ad1` and failed before this upgrade. The failed [deploy job](https://github.com/opentoolsorg/shiba/actions/runs/41679318599/job/126068413138) completed dependency installation and then failed during the Alchemy stack plan. Its log reports Cloudflare authentication errors with code `10000` for resource reads, alongside rate limit errors for other resources. This is evidence of deployment credential or API access failure, not evidence that the upgrade is deployable or that main is healthy.

No merge, deployment, credential mutation, or production acceptance run was performed for this audit. Type checks and local tests cannot substitute for testing configured Cloudflare resources, a real Slack app installation, provider egress, and live reconnect behavior after an authorized deployment.

## Additional installed tooling

The workspace image pins Agent Reach to revision `7a38047acf26a729cbb27851e3cb81639da86b29`, verifies the archive SHA-256 before installation, and retains its [MIT license](https://github.com/Panniantong/Agent-Reach/blob/7a38047acf26a729cbb27851e3cb81639da86b29/LICENSE). Installing the CLI does not grant credentials or widen Shiba's egress policy. DuckDB CLI is pinned to version `1.5.6`; both CLIs passed local installation smoke checks. The complete cloud image was syntax checked rather than executed against live Cloudflare infrastructure.
