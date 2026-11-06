# Slack coworker acceptance — 2026-11-06

## Scope and verdict

Backend fixture acceptance for Slack identity, private intake, native execution
approval, room audience sharing and separately approved outbound delivery.
Reviewed base: `293d895346788a2c84d45009c3612708fbe3102f`.
The checkout initially had no uncommitted changes; the parent coordinator's
uncommitted frontend identity-secret and room-link changes were **not** present
and are not verified by this report.

The requested Slack boundary suites pass. This is **not real Slack end-to-end
acceptance**, frontend acceptance, deployment verification or product-parity
completion. No real Slack message, OAuth installation, production account,
provider execution, deployment or PR was used. Existing backend source and tests
were not modified. One new store-level regression test fills an explicit
wrong-thread assertion gap; it does not replace signed-callback coverage.

## Evidence matrix

Paths below are under `apps/backend/`.

| Boundary | Source and executable evidence | Result / limit |
| --- | --- | --- |
| Two-sided identity confirmation | `src/slack-coworker-store.ts`: `observeSlackCoworkerChallenge`, `confirmSlackCoworkerOnSlack`, `confirmSlackCoworkerBinding`; `test/slack-coworker.test.ts` and `test/slack-coworker.security-v3.test.ts` | One-use challenge, exact installation/user and explicit Slack acceptance of the displayed native principal precede native confirmation. A planted code and acceptance by another Slack user cannot bind. Membership/installation changes fence stale authority. Signed callbacks use local fixture HMACs, not Slack transport. |
| Exact-thread private self-authored intake | `src/slack-coworker-store.ts`: `intakeSlackCoworkerEvent`; `test/slack-coworker.test.ts`; new `test/slack-coworker-exact-thread-acceptance.test.ts` | SQL binds installation/app/team/generation, channel, exact thread and bound Slack author. The new test explicitly denies another thread, a missing thread, another channel and another user, checks no private draft appears, then accepts only the authorized event once. Edits/deletes invalidate source drafts, including edits arriving before intake. |
| Explicit room audience consent | `src/slack-coworker-execution.ts`: preview audience snapshot, digest, `claimSlackCoworkerSubmission`; `src/slack-coworker-routes.ts`; `test/slack-coworker.security-v3.test.ts` | Submission requires native session, immutable reviewed preview and exact `share-my-slack-task-and-results-with-reviewed-room-audience` consent. Wrong consent, unreviewed decision, absent digest and raw draft submission are rejected. Current audience equality is enforced in SQL. UI presentation remains parent-owned and unverified here. |
| Human approval before execution | `test/slack-coworker-execution.integration.test.ts`; `test/slack-coworker-v2-proof.test.ts`; `src/slack-coworker-execution.ts` | Real native auth, membership, grant, room/approval and local-mailbox code with fixture Think/child/CLI transport. Native submission queues a pending approval; human review of frozen input is still required before dispatch. Altered task/recipient/grant, another member/workspace, forged decider and replay are denied. No deployment-operator credential/billing fallback. |
| Room bridge is separate from private intake | `test/slack-room-bridge.test.ts`; `src/slack-room-bridge.ts`; `src/collaboration-store.ts` | Explicit owner link of an observed exact thread plus configured permitted reader audience is required. A separately linked bridge intentionally accepts multiple Slack authors; this is not the private self-authored intake grant. Other owners cannot discover/link private sources; policy and reader-addition races are fenced. |
| Separately reviewed outbound Slack delivery | `test/slack-room-bridge.test.ts`; `src/slack-room-outbox.ts`: `deliverApprovedSlackRoomIntent` | Creating a room delivery intent does not post. Configured dashboard approver action, enabled outbox, exact destination/content binding, verified bot workspace and current source/author/audience authority precede mocked post. Execution approval is not delivery approval. |
| Revocation | `test/slack-coworker-collaboration-fence.test.ts`; execution integration suite; room bridge suite | Intake revocation blocks queued approval/dispatch and source task disclosure. Installation, membership, source, origin-policy and approver changes are rechecked. A message already sent cannot be unsent: in-flight successful receipts remain recorded; linked-room retained source context does not become freely shareable after unlinking. |
| Uncertain outcomes have no automatic retry | `test/slack-coworker.security-v3.test.ts`; v2 proof suite; room bridge suite | Lost queue outcome becomes `unknown` and submission cannot replay. Expired unconfirmed claims become unknown. Slack socket ambiguity, mismatched/lost receipts and receipt-persistence rejection preserve uncertainty and block replay, rather than silently resending. |
| Optional private status is not room publication | `test/slack-coworker-private-status.test.ts`; execution integration suite | Separate private-status consent is required. Only the frozen user/channel/thread target receives mocked ephemeral status; no room results are published. Concurrent ticks send once; revoked/expired authority blocks; lost receipts and abandoned claims are not automatically retried. |

## Focused verification

```sh
pnpm -C apps/backend test \
  test/slack-coworker.test.ts \
  test/slack-coworker.security-v3.test.ts \
  test/slack-coworker-v2-proof.test.ts \
  test/slack-coworker-execution.integration.test.ts \
  test/slack-coworker-private-status.test.ts \
  test/slack-coworker-collaboration-fence.test.ts \
  test/slack-room-bridge.test.ts \
  test/slack-installations.test.ts \
  test/phase1-core-loop.integration.test.ts \
  test/tradeoff-contracts.test.ts
pnpm -C apps/backend test test/slack-coworker-exact-thread-acceptance.test.ts
pnpm exec biome lint apps/backend/test/slack-coworker-exact-thread-acceptance.test.ts
```

Initial focused batch: **115 passed, 1 failed across 10 files**. All nine
Slack/installation/tradeoff files passed (100 tests). The core-loop suite had
15 passing tests, including the no-work-before-approval contract, and one
failure at `test/phase1-core-loop.integration.test.ts:612`: direct
execution-target intake expects HTTP 400 but receives 403. Its invalid-input
matrix includes `runtime: "local"` without dashboard intake. Current
`src/agents/orchestrator.ts` explicitly returns 403 for that local-intake
authority denial; the old assertion expects every invalid case to be 400.
This is a pre-existing assertion/source mismatch in the unchanged checkout,
not evidence of unauthorized execution. It remains unresolved for the parent;
neither the assertion nor production behavior was weakened here.

New exact-thread regression: **1 passed**. Its isolated lint check passed.

## Remaining live authorization and acceptance requirements

These are requirements for a separately authorized future run, not permission
to perform live actions now. Keep credentials in approved operator-managed
configuration; do not collect tokens or challenge secrets in chat or reports.

1. Explicit authorization identifying a non-production Slack workspace, test
   channel/thread, consenting human identities, permitted room readers, exact
   test messages and retention/cleanup limits. Native workspace membership and
   verified native sessions must belong to those consenting people.
2. An authorized Slack administrator must approve the app installation/scopes
   and operator-managed signing/OAuth configuration, callback routing and
   managed-installation activation. Locally synthesized signatures and seeded
   installation rows do not prove Slack configuration, delivery or installation.
3. The native principal must initiate a fresh identity challenge; the exact
   Slack user must explicitly accept the displayed native principal, then the
   native principal must confirm the observed Slack identity. Frontend secret
   handling and reload behavior need fresh verification against the integrated
   parent changes. Observation of a challenge alone is not identity consent.
4. Native human review must grant only the exact test channel/thread for private
   intake. Live positive and negative events must confirm denial of other
   users/channels/threads without importing unrelated private content.
5. The native requester must review the frozen draft, recipient, current room
   reader audience and personal-execution target, explicitly consent to room
   sharing, then separately approve the frozen execution input. A consenting
   owner must pair the intended local machine and grant the exact repository,
   harness, account/billing authority and expiry. Fixture CLI results do not
   prove a real paired runtime or model provider run.
6. A linked-room bridge requires the native owner to select the observed exact
   Slack source under operator-configured owner/viewer policy. It is distinct
   from private draft intake and needs its own reader-audience review.
7. Any actual outbound room post requires separately reviewed content and exact
   Slack destination, an explicitly enabled/configured room outbox and an
   authorized dashboard approver. That outbox currently uses its configured
   bot token and approval channel; a managed coworker installation alone is not
   authority/configuration for room posting. Optional ephemeral private status
   requires its own explicit consent and is not permission to publish results.
8. Live revocation and uncertain-outcome drills need explicit controlled-fault
   authorization. A human must reconcile any unknown outcome with Slack/native
   receipts; do not automatically retry or manufacture a fresh intent to bypass
   uncertainty. Confirm no subsequent intake/dispatch/send after revocation,
   while preserving legitimate receipts for already completed external writes.

## Handoff

Coordinator: `thr_0ccfb90cac0046cc9ea7a913fa511a12`. Only this document and the new exact-thread
test belong to this workstream. No frontend or existing-test edits, PR,
automerge or wider parity work are included. The supported inherited model was
used; unavailable Luna Max/DeepSeek routes were not used or claimed.
