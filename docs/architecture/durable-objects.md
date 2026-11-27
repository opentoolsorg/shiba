# State ownership

Durable Objects coordinate live state. They are not the only state in Shiba.
D1 owns durable shared domain records, R2 owns private object bytes, KV owns
small lookup state, Vectorize owns embeddings, and Queues and Workflows carry
asynchronous control. Put each fact in the store that owns its consistency and
query pattern.

## Coordination state

Current Durable Object bindings in `apps/backend/wrangler.jsonc`:

| Durable Object | Coordinates |
|---|---|
| **Room/Coding Orchestrator** (`CodingOrchestrator` in current code and binding) | Shared-room conversation, employee/run orchestration, approval queue, retained run lineage, delegation, and event-spine state for room and repository execution. |
| **Run Execution Agent** (`OpenCodeAgent` in current code and binding) | Sandbox-side execution child session, structured input envelope, progress, and result envelope. |
| `Sandbox` | Container lifecycle for one sandbox run. |
| `Automations` | Automation definitions and scheduled trigger coordination. |
| `Mailbox` | Serialized user-facing control mailbox and delivery state. |
| `Memory` | Conversation/user memory coordination and gated recall. |
| `Waitlist` | Waitlist signup and access state. |
| `ModelConfig` | Per-user provider/model/runtime configuration. |
| `LocalDispatch` | Durable mailbox for paired-machine work and completion. |
| `ChatGptAuth` | ChatGPT subscription authentication state. |
| `UserProviderOAuth` | User provider OAuth state. |
| `Spaces` | Shared workspace/space presence and coordination. |
| `ConversationRoom` | Room-scoped chat/session state. |
| `WorkspaceEvents` | Workspace event distribution and realtime coordination. |
| **Employee Runtime** (`EmployeeRuntime` in current code and binding) | Per-employee live actor-private conversation coordination, execution checkpoints, durable stream cursors, cancellation, recovery, routines, and private working memory. |
| `DiscordGateway` | Discord gateway connection state. |
| `BrowserSession` | Browser control/session state. |
| `ComputerSession` where configured | Dedicated computer allocation, evidence, control, and release. |

The MCP gateway is stateless. `createMcpHandler` runs per request and uses the
same control-plane services as other ingress surfaces.

## Shared domain state

D1 is the system of record for durable, queryable workspace facts. The migration
history includes workspace membership and invitations, collaboration and chat,
files and notes, knowledge indexes, employee profiles and access grants, employee
tool levels, workspace integrations, Slack installation and delivery state, team
model sessions, governance/audit exports, webhooks, founder jobs, shared
computers, connectors, external MCP configuration, coordination, billing, and
other relational domain tables.

Use D1 when several requests or workspace members must query the same durable
fact. Do not mirror a complete D1 record into a Durable Object only because a
live session uses it. Load the record, pin the version or authority snapshot in
the run envelope, and write results back through the owning control-plane path.

## Artifact, recall, and lookup state

| Store | Owns |
|---|---|
| R2 | Private artifact bytes, output archives, attachments, and generated files. Paths and metadata may be indexed in D1, but object bytes stay private in R2. |
| KV | Small token/config lookups where eventual consistency is acceptable. |
| Vectorize | Embedding vectors for recall. Retrieval must respect workspace, employee, source, and revocation policy. |
| Queues | Retryable job envelopes. A queue message is not authority by itself. |
| Workflows | Long-running orchestration and retry control. Workflow state is execution control, not domain truth. |

## Ownership rules

1. **Durable Objects serialize live coordination.** Use them for conversations,
   runs, sessions, dispatch, and realtime state that need strong serialization.
2. **D1 owns shared durable records.** Use relational state when workspace
   members, audits, dashboards, and integrations must query the same facts.
3. **R2 owns bytes.** Never place large artifacts or attachments in D1 or DO
   storage.
4. **Authority travels in explicit envelopes.** A run must carry approved scope,
   employee/profile version, resource bindings, expiry, and lineage. Do not infer
   authority from storage location.
5. **Events explain transitions.** Durable domain rows show current state. The
   event spine and receipts explain how the state changed.
6. **Deleting is ownership too.** Lane cleanup, container release, browser or
   computer session release, and artifact retention need explicit owners.

## Adding a stateful service

When you add a stateful service, update all of these in the same change:

- the Durable Object binding and migration tag in `apps/backend/wrangler.jsonc`;
- the matching binding in `alchemy.run.ts`;
- D1 migration and ownership code when the service has durable shared records;
- boundary types in `packages/shared` when another app or lane consumes it;
- this state map;
- the owning layer in `docs/architecture/structure.md`.

Do not add a second orchestration abstraction because one lane needs a new step.
Extend the owning run/event spine unless the new service has a separate live
consistency boundary.
