# shiba architecture

shiba is a pnpm/turbo workspace: a Cloudflare Worker backend that is both API
and static host, a React dashboard, an Astro docs/marketing site, and shared
packages. The central coordination role is the **Employee Orchestrator**: it
receives approved human intent, plans and delegates work to execution agents,
and never edits a repository itself. Work runs in ephemeral Sandbox containers
behind a human approval gate.

The architecture notes are in one file for each topic:

- [Repository structure](docs/architecture/structure.md)
  - [The one-paragraph version](docs/architecture/structure.md#the-one-paragraph-version)
  - [Layer breakdown](docs/architecture/structure.md#layer-breakdown)
- [Topology](docs/architecture/topology.md)
  - [Worker topology](docs/architecture/topology.md#worker-topology)
  - [Integration sibling](docs/architecture/topology.md#integration-sibling)
  - [Bounded automatic reads and isolated computers](docs/architecture/topology.md#bounded-automatic-reads-and-isolated-computers)
- [Durable Objects and state](docs/architecture/durable-objects.md)
  - [State map](docs/architecture/durable-objects.md#state-map)
- [Security model](docs/architecture/security-model.md)
- [Request lifecycle](docs/architecture/request-lifecycle.md)
- [Browser use](docs/architecture/browser.md)
- [Computer use](docs/architecture/computer-use.md)
- [Harnesses](docs/architecture/harnesses.md)
- [Change rules and known gaps](docs/architecture/change-rules.md)
  - [How this evolves](docs/architecture/change-rules.md#how-this-evolves)
  - [Cron job queue rollout](docs/architecture/change-rules.md#cron-job-queue-rollout)
  - [Known architectural gaps](docs/architecture/change-rules.md#known-architectural-gaps)
  - [Where to start reading the code](docs/architecture/change-rules.md#where-to-start-reading-the-code)
- [Internal signing migration](docs/architecture/internal-signing-migration.md)

**Companions:** `spec/GOAL.md` (product contract — *currently contradicted by
the tree*, see `PLAN.md` §17.2 T27) · `design.md` (visual design system) ·
`PLAN.md` (plan, gaps, §17 parity roadmap) · `VERIFICATION.md` (evidence).
