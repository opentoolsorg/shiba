# Channel acceptance matrix

Every chat lane (Slack, Discord, Teams, Telegram) must satisfy the same
security invariants, because a lane that violates one breaks the
approval-first model no matter how well its own tests pass. The matrix lives
in two test-only files:

- `apps/backend/test/helpers/channel-acceptance.ts` — the reusable harness:
  `runChannelAcceptanceSuite(name, makeRow)` registers the per-channel
  invariant tests, `runChannelAcceptanceMatrix(makeRows)` registers the
  cross-channel tests. Nothing in the Worker bundle imports it.
- `apps/backend/test/channel-acceptance.test.ts` — one row per lane. A new
  platform plugs in by adding one row; it may not skip an invariant by
  omitting parts of the row unless the platform genuinely lacks the surface
  (the row's `lane` fixture is the only optional part, and omitting it means
  the matrix proves nothing about that lane's replay handling).

## Invariants and where they are locked

| Invariant | What the matrix proves |
| --- | --- |
| Signature/auth | The lane's real transport accepts a correctly authenticated delivery, fails closed with 503 when its secrets are unset, refuses unauthenticated deliveries with 401 before parsing, and rejects a tampered body where the platform signs the bytes. Telegram (shared secret) and Teams (JWT bound to the serviceUrl) authenticate the delivery rather than the body; the row declares that with `bodyUnsigned`. |
| Dedupe | Parsing a delivery twice yields the same non-empty delivery id, message and action ids differ, conversation keys are namespaced `<channel>:` so lanes never share a dedupe or orchestrator namespace, and a replayed authenticated delivery through the real webhook handler triggers at most one unit of work. |
| No execution before approval | Intake (`queueChatRun`) only ever POSTs `/api/runs` — one call, no sandbox or execution endpoint — and queues nothing when the orchestrator cannot mint an approval. A replayed or expired decision resolves nothing. The publication executor refuses pending, rejected, executed, future-dated, or TTL-expired approvals. |
| Approver binding | Publication executes only for the channel's own allowlisted human (`SLACK_APPROVERS`, `TELEGRAM_APPROVERS`, `DISCORD_APPROVERS`, `TEAMS_APPROVERS`); a decider missing from the list, an `agent:`/`system:`/`automation:` prefix, or a decider allowlisted only on a different channel is refused before any GitHub traffic. |
| Result/postback shape | Approval card text carries the exact repo, frozen task, approval id, and the separate-publication notice within `CARD_TASK_LIMIT` bounds; the decision line names the decider and whether a run started; postbacks are capped per platform (Discord 2000, others 4000) and never post into web or unknown threads. |
| Publication pointer bounds | Decision pointers round-trip only as `{threadKey, approvalId}`; the publication proposal schema is strict with bounded digests, byte and file caps, an immutable `pr-publish:<runId>` approval id, and scope-checked owner/run/repo — the executor never widens it. |

## Relationship to the channel contract suite

`src/ports/channel/contract-suite.ts` (run by `test/channel-contract.test.ts`)
locks the transport/adapter behavior contract: parsing shapes, mentions,
capabilities, egress hosts. The acceptance matrix sits above it and locks the
*security* invariants across lanes, including the lane-level webhook handlers
and the publication executor. They overlap on signature verification
deliberately: the contract suite proves the mechanism, the matrix proves the
invariant holds for every lane at once.

## What the matrix does not cover

- Slack lane ingress dedupe is covered at the events-handler level; Slack's
  coworker lane behavior stays in `test/slack-coworker*.test.ts`.
- Teams postback delivery goes through `postTeamsTaskReply` and its stored
  reply addresses; the matrix covers the shared postback caps for the
  adapter-based lanes and leaves Teams reply-address lifecycle to
  `test/teams.test.ts` and `test/teams-worker.integration.test.ts`.
- Orchestrator-internal approval resolution is locked by
  `test/phase1-core-loop.integration.test.ts` and `test/pr-publish-approval.test.ts`;
  the matrix proves the lanes and shared plumbing never bypass it.
