# Domain docs

How engineering skills should consume this repo's domain documentation.

## Read before exploring

- [Root agent guide](../../../../AGENTS.md): canonical rules, validation cost
  posture, and instructions for using dated records.
- [Product contract](../../../../docs/product/ai-employees.md): current goals
  and acceptance criteria.
- [Architecture map](../../../../ARCHITECTURE.md): role names, system spine,
  and links to topic notes.
- [Security and authority model](../../../../docs/architecture/security-model.md):
  approval precedes execution, credentials stay out of sandboxes, and
  publication needs separate approval.
- `apps/web/docs/adr/`: read only the ADRs that touch the area you are changing.

`docs/plans/plan.md`, `docs/verification/verification.md`, and `docs/plans/roadmap.md` are dated records. Open only the
section needed for a task id, acceptance question, or historical claim.

## Standing constraints

The [original coding-spine goal](../../../../spec/GOAL.md) is historical, not
the current product contract. These constraints still apply:

- Each self-hosted installation is single-tenant and account-owned. Shared
  workspaces do not imply multi-tenant deployment isolation.
- Do not invent prices when documenting costs.
- Pass structured, validated inputs across the execution-child boundary. Do not
  scrape prose to infer the repository or approved scope.

## Use the architecture vocabulary

When output names a domain concept, use the term defined in the
[architecture map](../../../../ARCHITECTURE.md). Use **Employee Runtime**,
**Room/Coding Orchestrator**, and **Run Execution Agent** for architecture
roles. Use `EmployeeRuntime`, `CodingOrchestrator`, and `OpenCodeAgent` only
when referring to the current implementation bindings.

If a needed concept is missing, either the output is inventing project language
or the architecture has a real gap. Surface that gap instead of coining a term
silently.

## Flag conflicts

If output contradicts the product contract, an existing ADR, or a standing
constraint, surface the conflict explicitly rather than silently overriding it.
