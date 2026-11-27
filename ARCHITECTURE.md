# Shiba architecture

Shiba is a self-hosted, Cloudflare-native workspace for AI employees. People and
employees share workspace context; employees turn goals into approved plans and
tasks; approved work runs through scoped execution lanes; every result returns as
reviewable evidence, files, receipts, or a clear blocked/failed state. Publication
is a separate human decision, never implied by task execution.

The product target is [AI employees in a shared workspace](docs/product/ai-employees.md).
The architecture is therefore larger than the original coding-agent spine:
repository work is one execution lane beside artifact workspaces, employee app
actions, local machines, browser/computer-assisted work, research, marketing,
operations, automations, and channel-based collaboration.

## Role names and implementation names

Use product-role names in architecture and implementation names only where the
current binding matters:

| Architecture role | Current implementation | Meaning |
|---|---|---|
| **Employee Runtime** | `EmployeeRuntime` Durable Object | Provider-independent per-employee boundary for actor-private conversation state, working memory, routines, cancellation, recovery, resumable streams, and lightweight inference/tool turns. It never edits a repository or directly performs external effects. |
| **Legacy Room/Coding Orchestrator** | `CodingOrchestrator` Durable Object | Existing shared-room and repository-run spine: planning, approval queue, run lineage, delegation, and events. It remains authoritative for legacy room/coding flows while work is migrated into the employee runtime. |
| **Run Execution Agent** | `OpenCodeAgent` Durable Object | Optional sandbox-side execution child. Despite the legacy name, it coordinates the selected harness/runtime and makes no model product decisions of its own. |
| **Harness** | `opencode`, `claude-code`, `codex`, ACP lanes, etc. | A pluggable coding CLI/transport inside the repository execution lane, not the center of the product and not required for ordinary employee chat. |

A documentation rename is not a Durable Object migration. `CodingOrchestrator`
and `OpenCodeAgent` are still live code/binding names even where the architecture
uses product-role names. Do not claim either binding has been renamed until the
migration actually lands.

## Architectural spine

```text
people and channels
  → authenticated ingress and workspace context
  → EmployeeRuntime: employee identity, actor-private conversation,
    memory, routines, cancellation, recovery, and resumable live state
  → goal/plan/task with exact scope
  → human approval
  → run orchestration and event spine
    (legacy CodingOrchestrator for room/repository work until migration completes)
  → execution lane
  → deliverables, provenance, verification, receipts
  → human review
  → separately approved publication or follow-up
```

The load-bearing rule is unchanged: nothing executes before the required human
approval, credentials stay out of sandboxes, authority is scoped to the approved
target, and external publication requires its own exact approval.

## Architecture notes

- [Repository structure](docs/architecture/structure.md)
  - [The one-paragraph version](docs/architecture/structure.md#the-one-paragraph-version)
  - [Domain model](docs/architecture/structure.md#domain-model)
  - [Layer breakdown](docs/architecture/structure.md#layer-breakdown)
- [Topology](docs/architecture/topology.md)
  - [Employee platform topology](docs/architecture/topology.md#employee-platform-topology)
  - [Integration sibling](docs/architecture/topology.md#integration-sibling)
  - [Bounded automatic reads and isolated computers](docs/architecture/topology.md#bounded-automatic-reads-and-isolated-computers)
- [State ownership](docs/architecture/durable-objects.md)
  - [Coordination state](docs/architecture/durable-objects.md#coordination-state)
  - [Shared domain state](docs/architecture/durable-objects.md#shared-domain-state)
- [Security and authority model](docs/architecture/security-model.md)
- [Employee work lifecycle](docs/architecture/request-lifecycle.md)
- [Browser use](docs/architecture/browser.md)
- [Computer use](docs/architecture/computer-use.md)
- [Harnesses](docs/architecture/harnesses.md)
- [Change rules and known gaps](docs/architecture/change-rules.md)
- [Internal signing migration](docs/architecture/internal-signing-migration.md)

**Companions:** [product contract](docs/product/ai-employees.md) ·
[public architecture guide](apps/web/src/content/docs/docs/architecture.md) ·
[measured as-built snapshot](ARCHITECTURE-AS-BUILT.md) ·
[infra/auth/harness/monorepo](INFRA-AUTH-HARNESS-MONOREPO.md) ·
[UI architecture](UI-ARCHITECTURE.md) ·
[launch checklist](LAUNCH_CHECKLIST.md) ·
`spec/GOAL.md`, `PLAN.md`, and `ROADMAP.md` are dated coding-spine/platform
documents unless a section explicitly says it is current · `design.md` (visual
system) · `VERIFICATION.md` (dated evidence).
