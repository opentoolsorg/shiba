# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **AI employees in a shared workspace**: read the [product contract](../../../../docs/product/ai-employees.md) for current goals and acceptance criteria.
- **`CONTEXT.md`** at the repo root (single-context layout).
- **`apps/web/docs/adr/`**: read ADRs that touch the area you're about to work in.
- **[Security and authority model](../../../../docs/architecture/security-model.md)**: required approval precedes execution, credentials stay out of sandboxes, and publication needs separate approval.

If `CONTEXT.md` or `apps/web/docs/adr/` don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## Standing constraints

The [original coding-spine goal](../../../../spec/GOAL.md) is historical, not the current product contract. These constraints still apply:

- Each self-hosted installation is single-tenant and account-owned. Shared workspaces do not imply multi-tenant deployment isolation.
- Do not invent prices when documenting costs.
- Pass structured, validated inputs across the execution-child boundary; do not scrape prose to infer the repository or approved scope.

## File structure

```
/
├── CONTEXT.md
├── apps/web/docs/adr/
│   └── 0001-<slug>.md
├── docs/product/ai-employees.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as defined in `CONTEXT.md` or the [architecture](../../../../ARCHITECTURE.md). Use *Employee Orchestrator* and *Run Execution Agent* for the roles, and `CodingOrchestrator` and `OpenCodeAgent` when referring to the implementation.

If the concept you need isn't in the glossary yet, either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts the product contract, an existing ADR, or a standing constraint above, surface it explicitly rather than silently overriding:

> _Contradicts the single-tenant deployment constraint, but worth reopening because…_
