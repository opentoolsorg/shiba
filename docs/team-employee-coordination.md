# Named employee coordination foundation

Status: **disabled, review-only, and not production-ready**. This change does not
make employees call each other. `EMPLOYEE_COORDINATION_PRODUCTION_READY` is literal
`false`, every receipt says `executionAvailable: false`, and there is no environment
switch, route, model tool, executor, queue, provider transport or production ledger
instance. No migration or live account operation is included.

The existing human collaboration route still rejects an agent identity supplied
by a human session. Its nested-agent guard still returns 501, now with the explicit
`employee_coordination_disabled` code. Do not remove those guards to activate this
prototype.

## Why this remains disabled

Shiba's existing collaboration route and handoff store bind their sender to the
requesting human. They do not authenticate a calling employee's exact executing
run. A room membership, employee name, model-supplied parent ID, signed internal
request by itself, or another employee's approval is not sufficient authority.
The current cancellation and execution paths also do not participate in this new
ledger. Connecting only a happy-path call would bypass those boundaries.

A prior agent-ask service is a useful behavior reference: it resolves visible
named agents, derives caller lineage from retained runs, checks depth/cycles and
aggregate/per-turn budgets, and returns a bounded result. That does not establish
Shiba's funding, personal account or exact executable approval authority. This
foundation deliberately does not inherit owner access, fuzzy name selection,
automatic turn execution, or a budget refund after an uncertain external outcome.

## Implemented offline contract

[`employee-coordination.ts`](../apps/backend/src/employee-coordination.ts) contains
an unbound SQLite-backed, single-owner review ledger. A storage implementation must
provide synchronous transactions and durable acknowledgment, such as one SQLite
Durable Object. A lease or separate preflight/write sequence is not equivalent.
Its constructor creates only its own prototype tables when explicitly instantiated;
no production path instantiates it.

- Trusted root registration freezes the original human, root consent and approved
  run, exact room/workspace, named employee IDs and profile revisions, context
  digest, expiry and limits. The original consent, root run and root approval
  cannot be reused to open a second root budget. Roots cannot be changed or revived.
- Complete versioned references are required for the human and employee owners'
  workspace memberships, human and employee room memberships, employee profiles,
  original consent, root approval, selected context and active root run. References
  are server-owned and must be current in the same transaction as admission.
  Each source has a retained expiry; roots cannot outlive any dependency, and
  expiry is checked without relying on a scheduled invalidation writer.
- The caller verifier must supply the authenticated root, parent, run, approval,
  employee, profile and original human. The model submits only a replay ID, exact
  target employee ID, bounded task and explicit context. Extra fields are rejected.
- Depth is at most four, each parent can propose at most four children, and the
  aggregate root budget is at most 32. A root lasts at most one hour. The ledger
  derives the complete employee path and ancestor IDs from retained rows. Returning
  to any earlier employee, self-calls, unknown targets and changed profiles fail.
- Proposal creation and budget spending commit atomically. Identical retries return
  the retained receipt without another spend; changed task, context, target or
  parent under the same ID conflicts. Rejection, cancellation and uncertain
  durability acknowledgment never refund a committed proposal. There are no
  external actions to replay.
- Review approval requires a separately authenticated original human, exact proposal
  digest and new unique approval ID. First decisions are immutable. Agents have no
  human decision path, and every proposal grants an empty capability list. This
  approval is **review-only**, never an executable task approval or app/tool grant.
- A trusted, unbound run-observation seam lets fixture tests model future children.
  It requires the exact approved review, human, target, profile, a current run
  reference and a distinct current executable approval reference. Review and
  executable approval IDs cannot alias each other or another root's consent.
  Nested callers bind the executable approval, never the review approval. It cannot queue or execute work. Production must not call it until a
  separately verified executable approval and all dispatch conditions exist.
- Membership/profile/context/approval/run invalidation fences every subsequent
  proposal, decision and replay. Replacing a removed authority with a higher revision
  cannot revive old roots. Revoked ancestor runs or review approvals fence descendants.
  Original-human cancellation permanently fences the entire root. The human may stop
  after membership removal, but cannot use that exception to read or approve.
- Authority is rechecked after asynchronous caller verification and hashing, inside
  the commit, and again after durability acknowledgment before returning a receipt.

The ledger is a proposal/authority primitive, **not a live identity verifier or a
complete access-control system**. Its trusted registration, authority and observation
methods are not HTTP handlers. Installing snapshots without binding the real writers
would not satisfy this contract. Explicit context text remains untrusted content;
a hash alone does not prove its source, audience or permission to transmit it.

## Activation gates

All of these remain required before offering this feature:

1. An authenticated executor-bound caller proof, scoped to the exact run generation,
   tenant/workspace/room, original human and retained approval. No client/model claim
   or generic service token may impersonate an employee or human. Name lookup must
   resolve one visible, current, pinned employee, and refuse ambiguity.
2. A durable authority owner with canonical physical source identities. Every room
   and workspace membership writer, employee/profile writer, selected-source writer,
   human consent/approval writer and run cancellation/deletion writer must invalidate
   here before changing its source. Legacy processes must be drained. No snapshot
   backfill, stale writer or alternate route may restore authority.
3. An executable approval for the exact child instructions, repository/target,
   employee profile, selected sources, audience, allowed phases and applicable app
   actions. Review acceptance cannot be promoted into executable approval. Existing
   exact-action, no-agent-approval and approval-before-sandbox gates must remain.
4. Explicit destination and funding authority for every model/tool/provider phase,
   with time/token/spend limits. The count budget here is not a token or monetary
   budget. Personal Claude/Codex grants explicitly forbid automatic follow-up and
   must remain excluded until separately authorized end-to-end support exists.
5. Atomic dispatch claims and permanent outcome tombstones bound to this ledger,
   actual retained human approval, frozen context and run generation. Revalidate
   through queue, claim, resume, restart and completion. An unknown queue/dispatch
   outcome must not create a second execution or refund capacity.
6. Cancellation and revocation barriers reaching every queued/active executor, with
   honest pending/unknown outcomes and no machine, account or cloud fallback.
   The ledger currently fences future review operations only; it stops no live run.
7. Source-authorized, bounded result delivery in the original human-visible room,
   current membership/source rechecks, no private transcript inheritance, and a
   durable audit view. No new recipient or external message may be inferred.
8. End-to-end tests across real authenticated identities, durable owner/storage,
   runtime queues and cancellation, including removed/re-added members, profile and
   source changes, duplicate deliveries, crashes and uncertain outcomes. The current
   SQLite and route fixture tests are not deployed or live-provider acceptance.

## Verification scope

The focused offline suite is
[`employee-coordination.test.ts`](../apps/backend/test/employee-coordination.test.ts).
It uses real SQLite transactions with synthetic identity verifiers and no outbound
calls. Existing collaboration routes, employee handoffs and team run-isolation tests
remain regression coverage. See the
[verification note](verification/employee-coordination-20261107.md) for exact commands
and results.
