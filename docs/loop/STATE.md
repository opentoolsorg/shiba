# Loop state — research-employee acceptance

Goal: prove "one research employee from assignment to handoff" — marketer assigns
a two-product comparison to an employee, evidence hands to a second employee to
draft a brief, a second human reviews sources, requests a change, approves that
revision; then the owner removes the reviewer and their page loses access.
Method: five pairs from `shiba-ai-employee-reference-plan.md`; verdicts logged to
`.audit/research-employee.tsv`.

## Done

- Pair 1: assignment/handoff + reviewer paths mapped to code
  (collaboration-routes, -store, -context, -handoff-return, -approval-routes,
  -artifact-routes, -router, -mentions, -thread-post, CollaborationView).
- Pair 2: research design — `docs/loop/research-design.md`
  (Linear vs Jira, 5 approved sources, stopping rule, evidence record shape).
- Pair 3: evidence collected + independently checked —
  `docs/loop/evidence-collection.md` (7 supported/verified rows, 1 `missing`
  (Jira Standard seat price — JS-blocked), 1 `conflict` (third-party pricing)).
- Pair 4: smallest fills implemented and tested (60 tests pass in the two
  touched suites):
  - Fill A — chain continuation: a human who *sent* an active handoff may
    continue it to the next employee (sender = the assigning human, lineage +
    budget preserved, approval still gates the run). Contract widened to allow
    child sender ∈ {parent.recipient, parent.sender}; store SQL binds sender to
    the envelope instead of forcing parent.recipient. Dead 501
    `employeeCoordinationUnavailable` branch removed.
  - Fill B — reviewer interaction bound to a produced revision: new
    `GET|POST …/rooms/{roomId}/handoffs/{handoffId}/artifacts/{index}/review`
    on the room artifact route. Reuses the shared-ref check (exact
    index+artifactId+version+sha256) and the orchestrator's existing CAS
    `deliverables[i].review` (`expectedRevision`, approve / changes_requested
    with note). No new table. UI: Approve revision / Request change controls
    under each shared artifact link; "Continue handoff" now also lists handoffs
    the current user sent.
  - Files: packages/shared/src/collaboration-contract.ts,
    apps/backend/src/collaboration-routes.ts, collaboration-store.ts,
    collaboration-artifact-routes.ts,
    apps/frontend/src/components/CollaborationView.tsx (+ new tests).

## Next queue

1. Pair 5: full gate (typecheck done; backend suite running), commit, push,
   PR via $GITHUB_PAT REST on opentoolsorg/shiba.
2. Two-browser-profile live recording of the acceptance journey on wrangler dev
   (DASHBOARD_APPROVERS=default, --local-upstream localhost) — needs a real
   employee model on a verified SWE-2 Free session; unconfigured = blocked.
3. Citation check: verify brief claims against source passages in evidence doc.
4. Attach recording + evidence to PR before merge.

## Triage (needs human decision)

- Fill A is human-mediated: the assigner extends the chain. True
  employee-initiated delegation still parks behind
  `employeeCoordinationUnavailable()` (coordination ledger is review-only).
  Sufficient for the acceptance ("one employee hands to another" via the room),
  but it is not autonomous agent-to-agent.
- Fill B reviews bind to the artifact's run revision. A revision produced by a
  NEW run gets a new index/version — the reviewer must re-decide; the old
  decision stays on the old revision (correct: "approve that revision").
