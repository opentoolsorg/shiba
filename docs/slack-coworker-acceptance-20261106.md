# Slack coworker acceptance — 2026-11-06

## Verdict and scope

Backend fixture boundaries are verified at base `293d895346788a2c84d45009c3612708fbe3102f`; this is **not real Slack end-to-end acceptance**. Parent's uncommitted frontend identity-secret/room-link changes were absent and are not verified here. Parent separately reports browser checks passing; that is coordinator evidence, not this workstream's proof.

Only this document and new `apps/backend/test/slack-coworker-exact-thread-acceptance.test.ts` were added. No production code, frontend or existing test changed. No real Slack messages, OAuth installs, production accounts, credentials collection, deployment or PR. Supported inherited model used; no claim of Luna Max/DeepSeek use.

## Boundary evidence

All paths below are relative to `apps/backend/`.

- **Two-sided identity:** `src/slack-coworker-store.ts` and `test/slack-coworker{,.security-v3}.test.ts` prove one-use signed-side observation, explicit acceptance by the exact Slack user of the displayed native principal, then native confirmation. Planted codes, another Slack user, replay and changed membership/installation cannot bind.
- **Exact-thread private intake:** `intakeSlackCoworkerEvent` binds installation/app/team/generation, channel, thread and self-author. Existing coworker tests cover author/channel denial, deduplication and edit/delete invalidation. The new regression explicitly rejects another thread, missing thread, another channel and another user; confirms no draft appears; then accepts the authorized event exactly once. It is store-level proof, complementing existing signed-callback fixtures.
- **Explicit room consent:** `src/slack-coworker-execution.ts` freezes preview/digest/current room-reader audience and requires `share-my-slack-task-and-results-with-reviewed-room-audience`. Security-v3 tests reject wrong consent, unreviewed decisions, absent digest and raw submission; native session required. SQL checks current audience equality. UI presentation remains parent-owned.
- **Native approval before execution:** `test/slack-coworker-execution.integration.test.ts` exercises real native auth, membership/grants, room approval and local mailbox with fixture Think/child/CLI transports. Submission queues pending approval, not execution. Human approval of frozen input is required. V2-proof tests reject altered task/recipient/grant, public injection and replay; integration denies other members/workspaces/forged deciders and deployment billing fallback.
- **Separate room bridge:** `test/slack-room-bridge.test.ts` proves owner-only linking of an observed thread under configured permitted-reader policy, including reader-addition races. This intentionally multi-author linked-room lane is distinct from private self-authored draft intake. Unlinking does not erase retained history or authorize wider readers.
- **Separately approved outbound delivery:** Room-bridge tests and `src/slack-room-outbox.ts` prove creating an intent does not post. Configured dashboard approval, enabled outbox, frozen content/destination, verified bot workspace and current link/source/author/audience authority precede mocked posting. Execution approval is not delivery approval.
- **Revocation and uncertainty:** Collaboration-fence/execution suites block queued dispatch and source disclosure after intake revocation. Room-bridge tests recheck authority after delayed installation verification; successful in-flight receipts survive revocation. Lost queue outcomes, expired claims, socket ambiguity and receipt persistence failures remain `unknown` without automatic replay. Private-status tests require separate consent, exact private target, one-shot delivery and no room-result publication; revoked/expired sources and abandoned claims do not resend.

## Verification and unresolved issue

Relevant existing suites: `slack-coworker.test.ts`, `slack-coworker.security-v3.test.ts`, `slack-coworker-v2-proof.test.ts`, `slack-coworker-execution.integration.test.ts`, `slack-coworker-private-status.test.ts`, `slack-coworker-collaboration-fence.test.ts`, `slack-room-bridge.test.ts`, `slack-installations.test.ts`, `tradeoff-contracts.test.ts`.

Run with `pnpm -C apps/backend test` followed by those paths; all nine initially passed (**100 tests**). New exact-thread test passed separately; isolated Biome lint passed. A repeat alongside broad checks had one room-bridge signed-event timeout at the unchanged 5-second limit; no assertions/timeouts were weakened. After stopping the duplicate broader checks, the final combined boundary run passed **101 tests across 10 files** in 15 seconds, including the new test and room-bridge suite.

Adding `phase1-core-loop.integration.test.ts` produced **115 passed, 1 failed**. Its no-work-before-approval test passed. The failure reproduces in isolation at line 612: its direct-intake invalid-input matrix expects 400 but receives 403. The matrix includes local runtime without dashboard intake; current `src/agents/orchestrator.ts` explicitly denies that authority with 403. This pre-existing assertion/source mismatch remains for the parent, with no test or production change here.

Root typecheck, lint and lint:imports passed (lint has existing warnings). The duplicate broader root run was stopped following coordinator direction; no full-root success is claimed. Coordinator-reported build/test:built/check:ci/env:scan results belong to coordinator evidence.

## Exact remaining authorization for live acceptance

1. Explicit permission for a named non-production Slack workspace, channel/thread, consenting identities, permitted room readers, test messages and retention/cleanup limits; verified native accounts and active workspace memberships.
2. Authorized administrator approval of Slack app/scopes and operator-managed signing/OAuth/callback configuration plus installation activation. Seeded installation rows and local HMACs do not verify Slack delivery/configuration. Never collect credentials or challenge secrets in chat/reports.
3. Fresh native challenge, exact Slack user's explicit principal acceptance, then native confirmation. Verify integrated frontend secret handling and reload behavior separately.
4. Native reviewed grant for only the exact intake channel/thread, then authorized live positive/negative events without importing unrelated private content.
5. Native review of draft, recipient, current room audience and personal target; explicit room-sharing consent; separate frozen-input execution approval. Owner-approved machine pairing and exact repository/harness/account/billing grant with expiry. Fixture CLI output does not prove real provider/runtime execution.
6. Separate owner approval for any observed-thread room bridge under configured owner/viewer policy. A private draft grant is not room-link consent.
7. Separate exact-content/destination outbound review and authorized dashboard approval. Room outbox must be explicitly enabled/configured with its own bot token/approval channel; managed coworker installation alone does not authorize room posting. Optional private status requires its own consent.
8. Explicit authorization for controlled live revocation/uncertain-outcome drills. Human reconciliation of unknown Slack/native receipts before any new action; never automatic retry or fresh-intent bypass. Preserve receipts for already completed external writes.

## Handoff

Coordinator: `thr_0ccfb90cac0046cc9ea7a913fa511a12`. The coordinator fetched and reviewed handoff commit `3a8289571adc860eb0347ebe599b803e3889f8ee`, then integrated its exact-thread regression and report into the working tree. Final integration checks are recorded in `multiplayer-slack-roadmap.md`. No deployment or live Slack mutations were performed.
