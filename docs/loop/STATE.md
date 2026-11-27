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
  `docs/loop/evidence-collection.md` keeps Jira Free sprint availability
  unverified and separates the two Jira Standard price figures by source and seat quantity.
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

## Pair 5 result (recorded)

- Two-profile recording VERIFIED on wrangler dev (local): owner + reviewer
  Chrome profiles, room deep link, both views, review:approved on both
  deliverables, owner removed reviewer via UI, reviewer reload →
  "Access to this room ended." Videos + screenshots in .audit evidence set.
- Member-removal denial re-verified at API (room 404, artifact review 404).
- Citation check: fixture brief claims → named sources + [conflict] row,
  consistent with evidence.md v2 labels (model lane blocked → fixtures).
- Regressions: full gate green on branch; only failure is unrelated
  Docker Hub 429 sandbox test.
- Blocked checks recorded: model unconfigured (deliverables are fixtures),
  enrollment adapter off (reviewer identity seeded in D1), containers off.

## Next queue

1. Open PR on opentoolsorg/shiba with recording + screenshots attached
   (do not merge).

## Triage (needs human decision)

- Fill A is human-mediated: the assigner extends the chain. True
  employee-initiated delegation still parks behind
  `employeeCoordinationUnavailable()` (coordination ledger is review-only).
  Sufficient for the acceptance ("one employee hands to another" via the room),
  but it is not autonomous agent-to-agent.
- Fill B reviews bind to the artifact's run revision. A revision produced by a
  NEW run gets a new index/version — the reviewer must re-decide; the old
  decision stays on the old revision (correct: "approve that revision").

## Overlay UI parity loop (active)

Goal: Shiba web UI matches Overlay's workspace surfaces as closely as existing Shiba product contracts allow: icons, layout, padding, margins, hierarchy, neatness, and visual cleanliness verified in the Devin computer at desktop width. Evidence required: side-by-side reference/current screenshots plus fresh typecheck and focused tests.

Done:
- Review blockers fixed and pushed in 7f694f82 and c365b6ed.
- Files iteration 1 overhauled the dense legacy surface into a full-height Overlay-style screen; independent browser check found header/title/toolbar/row-density mismatches.
- Files iteration 2 matched Overlay objective metrics for header height/padding/border, title typography, first-row gap, row padding/radius, and filename typography. Evidence: `/home/ubuntu/shiba-ui-parity-artifacts/comparison-list-overlay-vs-shiba-iter2.png`; typecheck passed and 15/15 Files tests passed.
- Files iterations 3-6: search/create/upload now use compact Overlay-style controls; PDF asset renders; cards use wide masonry columns and type-framed icons; row height/pitch measured exactly `44.75px/46.75px`, matching Overlay. Evidence: `/home/ubuntu/shiba-ui-parity-artifacts/comparison-list-overlay-vs-shiba-iter6.png`; typecheck passed and 16/16 Files tests passed.

Next queue:
1. Decide and implement the backend/product scope for Overlay-style select mode, row actions, move, and delete; current Shiba Files contracts do not expose those mutations.
2. Repeat the visual loop for notes, projects, and navigation/sidebar.

Triage additions:
- Full Overlay parity beyond visual shell may require product scope decisions; no deployment or merge is authorized.
- Hover validation is limited in the Devin browser because it reports `hover:false` and `pointer:fine:false`.
