# Topology

This document shows the control and execution topology. It uses product-role
names first and current implementation identifiers in parentheses. A docs rename
does not rename a live Durable Object binding.

## Employee platform topology

```text
                         ┌──────────────── Ingress ────────────────┐
 Browser dashboard       │ REST/RPC auth · Slack/Teams/Discord/    │
 Docs/marketing sites    │ Telegram · email · MCP · webhooks ·     │
 Desktop/local clients   │ automations                             │
                         └──────────────────┬──────────────────────┘
                                            │ authenticated workspace context
                                            ▼
┌──────────────────── Cloudflare Worker: shiba control plane ───────────────────┐
│                                                                               │
│  EmployeeRuntime DO + CodingOrchestrator DO                             │
│  actor-private runtime chat/memory/routines · room/coding orchestration       │
│  approval queue · run lineage · durable event spine · cancellation/recovery   │
│                                                                               │
│  Authority plane                                                              │
│  workspace membership/roles · employee access/version · exact tool grants     │
│  approval freezing · resource/policy checks · publication receipts            │
│                                                                               │
│  Coordination state (Durable Objects)                                         │
│  EmployeeRuntime · Run Execution Agent (OpenCodeAgent) · Sandbox · Automations │
│  Mailbox · Memory · ModelConfig · LocalDispatch · ChatGptAuth · UserProviderOAuth       │
│  Spaces · ConversationRoom · WorkspaceEvents · DiscordGateway · BrowserSession│
│  Waitlist · optional computer/session control                                 │
│                                                                               │
│  Shared domain state                                                          │
│  D1 domain records · R2 artifact bytes · KV token lookup · Vectorize recall   │
│  Queues and Workflows for async/retryable work                                │
│                                                                               │
│  Stateless MCP gateway (createMcpHandler per request — not a DO)              │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ only after exact approval
                                ▼
┌──────────────────────────── Run/event spine ─────────────────────────────────┐
│ frozen scope · run/attempt lineage · progress · cancellation · receipts      │
│ deliverable provenance · verification state · publication evidence           │
└───────┬──────────────┬──────────────┬──────────────┬──────────────┬─────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌───────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ ┌─────────────┐
│ Repository    │ │ Artifact    │ │ Employee    │ │ Local      │ │ Browser/    │
│ sandbox lane  │ │ workspace   │ │ app/tool    │ │ paired     │ │ computer    │
│               │ │ lane        │ │ lane        │ │ machine    │ │ lanes       │
│ ephemeral     │ │ files and   │ │ integration │ │ daemon     │ │ operator or │
│ container,    │ │ generated   │ │ actions via │ │ claims     │ │ dedicated   │
│ one selected  │ │ deliverables│ │ policy and  │ │ approved   │ │ browser/    │
│ harness       │ │             │ │ receipts    │ │ work       │ │ computer    │
└───────┬───────┘ └──────┬──────┘ └──────┬──────┘ └─────┬──────┘ └──────┬──────┘
        │                │               │              │               │
        └────────────────┴───────────────┴──────────────┴───────────────┘
                                        │
                                        ▼
                         deliverables + provenance + verification
                                        │
                                        ▼
                                  human review
                                        │
                                        ▼
                  separate publication approval → external effect + receipt
```

## Repository sandbox lane detail

Repository work is a specialization of the platform flow, not the whole product:

```text
approved repository task
  → Run Execution Agent (OpenCodeAgent)
  → Sandbox container for one run
  → clone with scoped token
  → exactly one harness lane (opencode, claude, codex, ACP, ...)
  → collect diff/files/logs
  → push or artifact handoff
  → PR only after the relevant publication/PR approval path
```

The Run Execution Agent receives a structured envelope and coordinates the
sandbox/runtime flow. It does not independently plan product work or make model
calls of its own. Harness choice is a lane input, not architectural ownership.

## Integration sibling

OpenConnector (`openconnector/`, worker `shiba-openconnector`) is a sibling
service, not a module inside `apps/backend`. It owns:

- the public integration/plugin catalog (`catalog/`);
- OAuth and API-key connection setup;
- the read gateway and provider auth signing for governed reads;
- managed execute-provider configurations and connector SDK packages.

Shiba remains the control plane. Workspace connections and employee/member
grants in Shiba decide what may be used; task/run policy decides what may be
done; receipts and audit stay tied to the workspace/run. Catalog size is
connector breadth, not permission.

## Bounded automatic reads and isolated computers

Low-risk governed reads may run automatically only when they satisfy the bounded
read contract: exact integration/action/input, cheap idempotent read, no external
side effect, and durable evidence. They prepare approval context; they do not
turn into execution authority. Mutations, publications, messages, purchases,
repository writes, and irreversible actions require explicit approval.

Browser/computer-assisted work can use either operator-attached sessions or a
dedicated isolated `ComputerSession` for employee use. Browser sign-in state,
shared computer evidence, profile grants, and takeover control are separate
authority planes. Presence of a browser profile or computer session is not a
grant to use it.

## Output archives

Sandbox output archives are private by default. Container archives land in a
private R2 bucket; owner-only presigned URLs are minted when a user explicitly
opens output. Local-lane archives are encrypted client-side before upload. There
is no shared tenant object store.
