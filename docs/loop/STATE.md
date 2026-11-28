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
- Notes iterations 1-6: collapsed/panel typography, gutters, serif empty state, 6px sidebar radius, bottom-right formatting shell, Overlay action set, deletion affordance, and custom task rows now match objective Overlay measurements. Markdown round-trips underline/highlight/tasks/alignment, including nested tasks and hard breaks; realtime deletion recovers unsaved drafts as copies. Evidence: `/home/ubuntu/shiba-ui-parity-artifacts/notes-iter6-editor.png` plus iter4/iter5 comparisons; frontend typecheck and focused Markdown/Notes tests pass. Independent iter6 verification passed; the unexpected right alignment was TipTap `Mod-Shift-r` colliding with browser hard reload, not parser inheritance, and is fixed.
- Projects/navigation iterations 1-3: rail width, icon scale, panel width/radius/spacing, Projects controls/cards, and responsive stacking now closely match the closest Overlay shell/card measurements; picker overlap/overflow is eliminated at 1280px. Evidence: `/home/ubuntu/shiba-ui-parity-artifacts/projects-nav-iter3-evidence.png`; frontend typecheck and 41 focused tests pass.
- Files mutation parity iteration: select mode, bulk archive, row/card move-to-folder menus, and row/card archive controls implemented against Cloudflare/D1 PATCH/DELETE file routes; backend store tests and 9 focused Files UI tests pass.
- Shell parity iteration: desktop rail/context/main now form Overlay-style full-height adjacent surfaces (`0/60/332px` x positions, no gaps, flat main surface); secondary panel shell, 34px nav rows, rail/footer controls, and Projects header metrics match Overlay’s current `DoubleSidebar` measurements. Evidence: `/home/ubuntu/shiba-ui-parity-artifacts/shell-parity-iter3-evidence.png`; independent browser measurements pass, Projects/Files/Notes visual smoke passes, Knowledge destination rows render matching leading 16px icons, and focused frontend tests pass.
- Files detail-view iteration: files now open in an Overlay-style detail viewer with back/close navigation, metadata, authenticated download links, rendered Markdown/text/CSV source, sandboxed generated-page preview detection, PDF/image/audio/video media viewers, and a safe download fallback for unsupported formats. Query-string deep links use `?file=<id>`. Verification: frontend typecheck, Biome check, and 13/13 FilesView tests pass.

Next queue:
1. Land file-detail viewer slice in PR #390, then continue files parity: editable text/markdown source with versioned Worker writes, nested folder tree/browser + breadcrumbs, memories/outputs unified knowledge tabs, richer note/file creation and move/rename dialogs.
2. Chat/work parity: compare Overlay `chat-parity` fixture against Shiba threads/work composer, then implement verified vertical slices without changing Shiba labels.
3. Extensions/automations parity: compare Overlay `/app/tools` and `/app/automations` capability grouping, connector states, and automation creation/run history with Shiba's existing panels.
4. Desktop parity: install and test on the user's Mac after local-machine approval; cloud web retest remains tied to `pal265354@gmail.com`.

Remaining parity matrix (audited after PR #390): Shiba already has broad product surfaces for agents/chat/work/files/notes/outputs/projects/extensions/automations/settings, but Overlay parity is incomplete in interaction depth rather than shell presence. Highest-value verified gaps are file source editing, folder tree navigation, unified knowledge tabs and route state, chat parity harness behavior, extension connector grouping, automation run history, and desktop install proof.

Triage additions:
- Full Overlay parity beyond visual shell may require product scope decisions; no deployment or merge is authorized.
- Hover validation is limited in the Devin browser because it reports `hover:false` and `pointer:fine:false`.
