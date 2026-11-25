# Architecture import prompt — retired

This file used to be a prompt for importing patterns from an external reference
implementation into the original coding-agent spine. It is no longer a source of
truth for Shiba architecture.

Do not use the old prompt as implementation guidance. It assumed that the main
problem was a coding-agent control loop. Shiba's current direction is broader:
an approval-first AI employee workspace with repositories, artifact workspaces,
employee app actions, local machines, browser/computer sessions, deliverables,
verification, and publication receipts.

## Current reading order

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) — canonical living architecture.
2. [`docs/product/ai-employees.md`](docs/product/ai-employees.md) — product
   contract for employees and shared workspaces.
3. [`ARCHITECTURE-AS-BUILT.md`](ARCHITECTURE-AS-BUILT.md) — measured current
   implementation snapshot.
4. [`INFRA-AUTH-HARNESS-MONOREPO.md`](INFRA-AUTH-HARNESS-MONOREPO.md) — current
   end-to-end backend flow, auth boundaries, harnesses, and monorepo ownership.
5. [`UI-ARCHITECTURE.md`](UI-ARCHITECTURE.md) — client target shape.
6. [`PLAN.md`](PLAN.md) — dated implementation tracker and historical evidence.

## What survived from the import work

Some imported ideas are now part of the implementation and should be evaluated
on their own merits rather than by reference to their source:

- structured run events instead of unstructured progress text;
- capability-aware harness adapters;
- durable command/run receipts;
- scoped command execution;
- hidden git checkpoints;
- clear separation between account credentials, continuation identity, and
  runtime authority;
- no fake success when verification is missing;
- fail-closed authentication and callback validation;
- one approval boundary shared by sandbox and local execution.

These are now Shiba design requirements. Future changes should cite the current
code, tests, and architecture invariants directly.

## What no longer applies

- the assumption that repository coding is the whole product;
- the assumption that OpenCode is the central agent;
- a local-first provider architecture as the primary deployment model;
- any instruction to copy external file layout or provider code mechanically;
- any plan that bypasses Shiba's workspace, employee, approval, artifact,
  integration, or publication boundaries.

## Rule for future architecture imports

Import a pattern only after answering these questions in the current codebase:

1. Which Shiba product object does it improve?
2. Which execution lane uses it?
3. Which approval and authority envelope carries it?
4. Which receipts or evidence prove it worked?
5. Which existing module owns it?
6. What becomes simpler or safer after the import?

If the answer is only that another product does it, do not import it.
