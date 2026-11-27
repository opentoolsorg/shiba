# Repository structure

```text
shiba/
├── ARCHITECTURE.md            # canonical architecture entrypoint
├── README.md                  # product-facing overview
├── docs/product/              # product contracts and acceptance boundaries
├── docs/architecture/         # living architecture notes
├── spec/                      # contracts; some files are slice- or era-specific
├── apps/
│   ├── backend/               # Cloudflare Worker: API, Durable Objects, queues,
│   │                          # workflows, integrations, execution control, static assets
│   ├── frontend/              # React dashboard source, built into apps/backend/public
│   ├── web/                   # Astro + Starlight marketing/docs site
│   ├── docs/                  # mintlify docs source, static-exported into the backend
│   └── local-daemon/          # optional paired-machine daemon
└── packages/
    ├── shared/                # protocol and control-plane types used across boundaries
    └── ui/                    # reusable dashboard primitives
```

## The one-paragraph version

One Cloudflare Worker (`apps/backend`) serves the API and hosts the built React
dashboard. Durable Objects coordinate live conversations, runs, sessions,
mailboxes, and realtime state; D1 holds durable shared domain records; R2 stores
private artifact bytes; KV stores token lookups; Vectorize stores embeddings;
Queues and Workflows carry asynchronous work. `EmployeeRuntime` is the
provider-independent per-employee boundary for actor-private chat, memory,
routines, cancellation, recovery, resumable streams, and lightweight tool turns.
The legacy shared-room and repository-work spine is still exported as
`CodingOrchestrator`; it remains authoritative there while orchestration is
migrated. Approved work enters the run/event spine and is claimed by one
execution lane. Repository work uses an ephemeral Sandbox
container and a sandbox-side **Run Execution Agent** — currently implemented as
`OpenCodeAgent` — which coordinates exactly one selected harness. Artifact, app,
local-machine, browser, computer-assisted, research, marketing, and operations
work follow the same approval, evidence, and publication boundaries even when
they do not use a repository sandbox. The MCP gateway is stateless
(`createMcpHandler` per request), not a Durable Object. Nothing runs before the
required approval; credentials never enter containers.

## Domain model

The canonical work chain is:

```text
Workspace → Member → Employee profile/version → Goal → Plan → Task
  → Approval → Run/attempt → Action/tool call → Deliverable/version
  → Verification → Receipt/publication
```

| Concept | Architectural meaning |
|---|---|
| **Workspace** | Shared boundary for people, employees, context, integrations, work, memory, and audit. Has explicit membership, roles, and human ownership. |
| **Employee** | Durable identity with instructions, responsibilities, skills, model/runtime bindings, allowed resources/tools, versioned configuration, and readiness state. Hiring/configuring does not start work. |
| **Goal** | Owner-led outcome with success criteria, scope, and lead employee. |
| **Plan/task** | Human-reviewable decomposition. Tasks can belong to people or employees and can produce child goals/tasks when authorized. |
| **Approval** | Exact frozen authority: actor, employee version, target, action, resources, expiry, and limits. Generic consent is not execution authority. |
| **Run/attempt** | Durable execution lineage with events, cancellation, retry, receipts, and parent/child relationships. |
| **Execution lane** | Sandbox harness, artifact workspace, app/tool integration, paired local machine, browser/computer session, automation, or non-repository reasoning/output lane. |
| **Deliverable** | Durable output with provenance, lineage, verification state, and versions. A PR is one publication form, not the only output. |
| **Publication** | A separately approved external effect, idempotently anchored to a receipt. Execution success never implies permission to publish. |

Employee-to-employee delegation is a regulated child-authority path, not a
hidden agent network. It remains review-only until its activation gates in
`docs/team-employee-coordination.md` are satisfied.

## Layer breakdown

| Layer | Key files | Role |
|---|---|---|
| **Presentation** | `apps/frontend`, `apps/web`, `apps/docs` | Dashboard, public docs, marketing surfaces. Frontend is built by turbo into `apps/backend/public`; Cloudflare Workers Assets serves it. |
| **Ingress/API** | `apps/backend/src/index.ts`, `routes/`, channel ingress | Authentication, workspace selection, REST/RPC, Slack/Teams/Discord/Telegram/email/webhook/MCP ingress. |
| **Employee runtime** | `apps/backend/src/employee-runtime-do.ts`, `employee-runtime-store.ts`, `employee-runtime-routes.ts` | Provider-independent actor-private conversation state, memory, routines, execution checkpoints, stream cursors, cancellation, recovery, and lightweight tool turns. |
| **Legacy room/coding orchestration** | `apps/backend/src/agents/orchestrator.ts` | Shared-room conversation, goal/plan/task interpretation, approval queue, delegation, and run lineage. Current implementation `CodingOrchestrator`; migration into the employee runtime is in progress. |
| **Run execution control** | `apps/backend/src/agents/opencode-agent.ts`, sandbox/run modules | Structured execution envelope, progress/events, result envelopes. Conceptual Run Execution Agent; current implementation `OpenCodeAgent`. |
| **Authority and policy** | approvals, workspace/employee access, tool policy, funding/receipt modules | Decide whether a run/action is executable, what exact resources it may use, and whether a result may be published. |
| **Execution lanes** | sandbox harnesses, artifact workspace, integrations, local daemon, browser/computer sessions | Perform approved work. Lanes share lineage and evidence contracts but have lane-specific runtimes. |
| **Coordination state** | Durable Object bindings in `apps/backend/wrangler.jsonc` | Serialized live state for conversations, employee runtimes, runs, mailboxes, realtime sessions, dispatch, provider auth, and computer/browser sessions. |
| **Shared domain state** | D1 migrations and query modules | Durable workspace/domain records and relational queries. |
| **Artifacts and recall** | R2, KV, Vectorize, memory modules | Private object bytes, token lookup, embeddings/recall, governed memory. |
| **Async control** | Queues and Workflows | Retryable jobs and long-running orchestration. They are infrastructure lanes, not places to hide authority decisions. |
| **Integrations** | workspace integrations, OpenConnector boundary, external MCP | Connected apps and tools. Connections/grants are workspace authority; execution still requires task-level approval/policy. |
| **Deployment** | `alchemy.run.ts`, `apps/backend/wrangler*.jsonc`, turbo | Infrastructure definitions, environment-specific deploys, preview/dev configuration. |

## Keep this document current

When adding a stateful service, update `apps/backend/wrangler.jsonc`,
`alchemy.run.ts`, the state map in `docs/architecture/durable-objects.md`, and
the owning layer row here. When adding an execution lane, document its approval
input, evidence/result envelope, egress/credential model, cancellation behavior,
and publication boundary before treating it as production-capable.
