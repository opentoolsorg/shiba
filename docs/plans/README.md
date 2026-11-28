# Feature plans

Use this directory for substantial feature work that ships over more than one
PR. Keep the plan small. It is a coordination document, not a place to store
implementation notes that belong in code or living documentation.

## Required shape

Each feature plan starts with:

1. **Problem** — the user-visible gap and why it matters.
2. **Non-goals** — what this feature deliberately does not change.
3. **Current fit** — the existing architecture or contract the feature must preserve.
4. **Decisions** — owner-approved choices, each with a date.
5. **Phases** — small PR-sized slices. Each phase names its exact acceptance check.
6. **Status** — what is merged, what is in review, and what is not started.
7. **Living doc** — the canonical document that will own the behavior after merge.

## Daily execution rule

Ship one focused phase per PR. Do not mix independent features in one PR unless
they share the same acceptance check. Update the plan, the owning living doc,
tests, and QA evidence in the same commit as the behavior change.

A new head supersedes earlier QA. Before merge, the PR carries a current `QA
handoff` comment with the exact tested SHA, labels or lanes used, evidence,
and unverified remainder.

Archive or delete a plan when its work is done. Do not keep stale plans as
agent context.
