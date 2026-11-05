# Independent v4 security checkpoint

## Combined scheduled-report Slack increment — baseline c5c1567

Focused review completed 2026-11-05 at approximately 13:45 UTC. No new concrete blocker was found in the inspected increment. This is separate from whole-PR review and from root's routine integration gates.

Inspected the new reconciliation Slack source/store/routes/tick, migration 0034, generated renderer manifest, shared contract, client and panel, existing schedule panel's explicit private-report handoff, and route/cron/default-off configuration. The source adapter validates actual completed scheduled reports, recomputes comparison rows/totals from current native receipts, and pins original owner/membership, immutable parent/source contracts, exact receipt bytes/hash, fixed selections and leases. It uses no fabricated dashboard session and starts no source/model work. The parent counters/next-due time are not frozen as continuing delivery authority. The disclosure and different-manager approval guard the exact managed installation, room/link and stated current/future Slack audience. The final send proof includes the immutable delivery row, current source graph and shared sending/unknown ledger. Unknown outcomes do not retry. The fixed projection includes every comparison row and qualifications; oversized output is rejected, not truncated. Renderer pin verification covers the source adapter, store, tick and shared renderer/escaping.

Two new independent cases in `apps/backend/test/founder-reconciliation-slack.security-v4.test.ts` passed:

- Create and approve delivery after the parent's original manual-sample review expiry, then advance to the actual next-day producer deadline without modifying the schedule's next-due field. Actual source capture and comparison production progress the parent to exhausted; its last new eligible result sends once. Delivery itself makes no extra provider calls. This verifies that expired original sample review and changed dynamic parent counters do not silently disable valid standing authority.
- Pause the parent during managed-bot verification after a real next-day result is produced. The final source proof blocks the Slack post.

Focused reruns, once implementation was reported frozen:

```sh
pnpm --filter @shiba/backend exec vitest run test/founder-reconciliation-slack.security-v4.test.ts --maxWorkers=1
# 2 passed
pnpm --filter @shiba/backend exec vitest run test/founder-reconciliation-slack.test.ts --maxWorkers=1
# 12 passed
pnpm --filter @shiba/frontend exec vitest run src/founder-reconciliation-slack-client.test.ts src/components/FounderReconciliationAutomaticSlack.test.tsx src/components/FounderReconciliationSchedules.test.tsx --maxWorkers=1
# 19 passed
node apps/backend/src/founder-reconciliation-slack-manifest.mjs --check
# passed
```

Logs: `/tmp/shiba-combined-security.log`, `/tmp/shiba-combined-backend-final.log`, `/tmp/shiba-combined-frontend-final.log`. The 14 backend cases comprise two independently authored regressions and 12 owner cases; the 19 frontend cases are existing focused owner/root fixtures. They are not 33 new independent security cases. Covered owner fixtures include two-human disclosure, private draft denial to managers, source revocation during preflight, oversize refusal, cross-family destination exclusion and unknown latch, concurrent claim, native session removal/held-proof expiry, renderer mutation, disabled-source metadata cleanup, scoped/stale frontend responses and explicit parent handoff.

Limits: fake provider/Slack transports, local SQLite rather than live D1/network, controlled native-auth snapshot rather than real cookie verification, and component fixtures rather than deployed browser E2E. No real send, accounts, credentials, provider/model spending, Git/deploy, whole suite or whole-PR approval. Root retains final type/lint/build/migration/CI gates. Previously delivered Slack messages cannot be withdrawn by later revocation.


## Standing private reconciliation increment — baseline b5d8eb8

Focused review completed 2026-11-05 at approximately 12:56 UTC. This increment was reviewed separately from the earlier native-founder work below. Production changes remained with root/backend owners. No subagents, full suite, real provider requests, model calls, Slack sends, Git operations or deployments were used.

Two concrete findings were reported before fixes:

1. **Stale no-pair tick shortened the consented daily cadence.** The new independent `apps/backend/test/founder-reconciliation-schedule.security-v4.test.ts` held tick A immediately before its no-pair `next_due_at` update. Tick B created fresh native source captures, reserved and completed a comparison, and persisted a 24-hour deadline. Tick A then resumed and overwrote it with a one-hour deadline. Actual production SQL in SQLite reproduced the failure. The owner added a compare-and-set against the original next-due time, used-comparison count, cutoff and immutable source/contract snapshots. The independent regression now passes.
2. **Frontend rejected genuine schedule principals.** The runtime emitted `schedule:frs_…`, while the client compared the principal to bare `frs_…`. Root aligned the client and fixture with the backend, and the shared schema now enforces the exact prefixed schedule identity. The report additionally carries and validates standing digest/source-grant pins; the client compares the fixed Stripe interval and rejects reuse of the sample receipt IDs.

Reviewed paths: schedule sources/store/runtime/routes/manifest/migration 0033; browser-safe schedule schema; schedules client and component; explicit button mounts, default-off environment flag, authenticated route mount and serial cron integration. Source grants remain separately authorized; the timer performs only local comparison. Create/enable atomic SQL includes the current sample and exact native-session proof. Cron uses original-owner/source authority without a fabricated human session. Reservation and settlement, current-source guards, pause/revoke, bounded candidate selection, unknown local acknowledgement recovery, and final private response proofs were inspected. Source grant leases and original sample receipt leases are kept separate in the reviewed DTO. The UI uses actor/workspace/sample keys and abort/epoch guards; stale or hidden-tab private result responses cannot repopulate the panel through the reviewed report path.

Independent rerun:

```sh
pnpm --filter @shiba/backend exec vitest run test/founder-reconciliation-schedule.security-v4.test.ts test/founder-reconciliation-schedule.test.ts --maxWorkers=1
# 15 passed across two files; one newly authored independent regression
pnpm --filter @shiba/frontend exec vitest run src/founder-reconciliation-schedules-client.test.ts --maxWorkers=1
# 4 passed
node apps/backend/src/founder-reconciliation-schedule-manifest.mjs --check
# passed
```

Logs: `/tmp/shiba-schedule-security.log` (initial RED), `/tmp/shiba-schedule-security-final.log` and `/tmp/shiba-schedule-client-final.log`. The backend fixture uses actual SQLite/D1 statements, real native source capture/crypto paths with fake providers, and rejects over 100 bind values. It covers concurrent reservation, durable acknowledgement-loss recovery, pause/revoke, expired enable review, source change, exact-session removal and private route suppression. These are selected owner tests plus the independent regression, not 19 newly authored security cases.

No remaining concrete blocker was found in this focused delta after the fixes. Limits: no live D1 transport or deployed cron restart, real cookie validation, provider compatibility, browser E2E/component test run, entire-project type/lint/build or whole-PR audit by this reviewer. Root retains those integration gates. A final proof cannot retract bytes already delivered before a later revocation.


This is a focused review of the isolated `/workspace/shiba-v4` worktree. Production files, Git operations, deployments, provider accounts, credentials, model calls and Slack sends were not changed or exercised by this reviewer. This is not whole-PR certification; the earlier whole-PR automated review was skipped for size.

The current native-founder delta review completed on **2026-11-05 at approximately 12:10 UTC: 37 backend and 18 frontend cases passed** in selected files. This includes independently authored regressions and owner-authored suites run by this reviewer; it is not 55 newly authored independent cases. The earlier 11:07 checkpoint had 23 independent cases in four files. Counts overlap and must not be added together. Root retains final-head integration checks. Source changes after this review require a delta review.

## Current native-founder delta

One concrete private-output bug reproduced in `stripeSlackView`: after its final successful SQLite proof, delaying the result past the sample or actual database session expiry still returned the private sample. The two new cases in `apps/backend/test/founder-stripe-slack.security-v4.test.ts` initially failed. After the owner's fix, both pass: the final snapshot returns the database session expiry, synchronous checks bound the requesting session, database session, standing grant, source grant and installation leases, and an expired sample is omitted. The test intercepts the actual final D1 statement and advances the clock only after its successful result; it does not duplicate the authority policy.

Reviewed production paths include native HubSpot credential/read/store/runtime/routes; reconciliation source/store/session/routes/compute; Stripe Slack source/store/routes/tick and shared escaping; corresponding shared schemas and frontend clients/components; and root route/cron/environment/UI mounts. Findings and checks:

- Native HubSpot uses a separate encrypted credential and fixed account GET and selected-deal batch-read POST. Exact account, selected IDs/properties, verified currency/timezone, original owner/version, contract/executor, current session for human decisions, quota and receipt bytes are pinned. Token ownership/appropriateness remains creator attestation; successful account verification does not establish read-only token permissions.
- Reconciliation now consumes actual native HubSpot and Stripe receipts. The earlier unregistered HubSpot fixture limitation below is superseded. No provider read occurs during comparison. Final route proofs repeat current source and exact-session checks after the awaited store result. Updated independent tests execute native HubSpot capture with a fake provider and real SQLite, then test composition/session revocation, source revocation, membership non-revival and byte/hash substitution.
- Stripe Slack requires explicit owner future-disclosure consent and a different configured native manager approver. The fixture tests exact destination/installation authority, future receipts, one-time delivery, concurrent reservation, cross-family unknown suppression, uncertain-outcome no retry, current human session, and revocation during bot verification. The renderer manifest binds the Stripe source adapter and the shared renderer/escaping implementation; its generated pin check passes. This lane is a qualified fixed-row summary, not the older OAuth complete-report contract.
- Global mounts keep provider setup default-off with a separate Worker-only HubSpot encryption secret. UI panels mount after explicit buttons, remain keyed to native actor/workspace, and use scoped clients and abort/generation checks. No new billing, model, provider-write or identity-derived disclosure authority was found in these inspected paths.

Focused commands (all local, no real external calls):

```sh
pnpm --filter @shiba/backend exec vitest run test/founder-stripe-slack.security-v4.test.ts test/founder-hubspot-lifecycle.test.ts test/founder-hubspot-read.test.ts test/founder-hubspot-routes.test.ts test/founder-reconciliation-source.security-v4.test.ts test/founder-reconciliation.security-v4.test.ts --maxWorkers=1
# 28 passed
pnpm --filter @shiba/backend exec vitest run test/founder-stripe-slack.test.ts --maxWorkers=1
# 9 passed
pnpm --filter @shiba/frontend exec vitest run src/founder-hubspot-client.test.ts src/founder-reconciliation-client.test.ts src/components/FounderHubSpotReads.test.tsx src/components/FounderReconciliation.test.tsx src/components/FounderStripeAutomaticSlack.test.tsx --maxWorkers=1
# 18 passed
node apps/backend/src/founder-hubspot-manifest.mjs --check
node apps/backend/src/founder-reconciliation-manifest.mjs --check
node apps/backend/src/founder-stripe-slack-manifest.mjs --check
```

Logs: `/tmp/shiba-v4-independent-current.log`, `/tmp/shiba-v4-independent-slack-base.log`, `/tmp/shiba-v4-independent-front.log`. A direct ESLint invocation on the new backend test was ignored by the repository configuration, so it is not claimed as lint coverage. No unresolved concrete blocker remains from this focused review.

A final read-only skim also covered the package-prefetch retry diff, Docker apt retry setting and desktop workflow fixture step. Prefetch permits three total attempts (two retries) for only 408/429/500/502/503/504, checks exact URL/redirect before retry, and leaves size/hash/manifest failures terminal. Abort can wait for the current 250/500 ms backoff to finish but is checked before another fetch. Static diagnostics do not include raw transport/server/IO errors. The reviewer did not rerun the owner-reported 33 package cases or attempt real image/network builds; intermittent retrieval failures are not evidence of successful live compatibility.

## Earlier independent checkpoint and current fixture updates

| Test file | Boundary and evidence |
| --- | --- |
| `apps/backend/test/founder-auto-read-keys.security-v4.test.ts` | Four passing cases against the actual scoped-key parser and WebCrypto HMAC. Duplicate JSON names, escaped names, nonstring earlier duplicate values, malformed same-source duplicates, unrelated tenant coexistence, exact source/tenant binding and key rotation. Initial duplicate-property acceptance reproduced; the first fix still accepted a nonstring earlier duplicate. The corrected parser counts every decoded property name regardless of value type; both regressions now pass. |
| `apps/backend/test/founder-reconciliation.security-v4.test.ts` | Actual arithmetic implementation. Ambiguous invoice/deal IDs excluded from totals, exact decimal units, separate currencies, unsafe numeric inputs and unsupported currencies, absence qualified to captured inputs and selected-but-uncaptured deals. Five cases passed. This does not establish a live HubSpot source. |
| `apps/backend/test/founder-reconciliation-source.security-v4.test.ts` | Six passing cases against the actual reconciliation source loader, store, routes and generated SQL with stored Stripe grant/receipt rows. Revoked deciding session prevents composition with zero report writes; Stripe revocation at final combined proof prevents disclosure; original membership version cannot revive; a replacement invoice with a valid new hash cannot replace a reviewed snapshot. Two route cases revoke the exact session or Stripe source after the store's successful proof: the final route proof withholds report bytes. At the earlier checkpoint HubSpot authority was mocked; the current six-case rerun uses native HubSpot grant/receipt SQL and a fake provider capture instead. |
| `apps/backend/test/founder-meta.security-v4.test.ts` | Eight passing cases against actual routes, store, crypto, scheduler and SQLite-backed D1; fake provider and native-auth snapshot. Four report session/source/expiry cases, concurrent unknown-outcome reservation, revocation after reservation acknowledgement, native decision revocation and manual-verification lease expiry. The decision regression initially returned HTTP 403 while still enabling future calls; the owner's atomic exact-session mutation guards now prevent that effect. Manual verification also makes zero provider calls when its final positive proof returns after native-session expiry. |

The D1 fixture executes production SQL and atomic batches in SQLite. Native authentication in these tests supplies a controlled authenticated-session snapshot; the final SQL uses an actual session row. These tests do not exercise browser cookie verification or deployed D1 transport.

Executed focused commands used `pnpm --filter @shiba/backend exec vitest run ... --maxWorkers=1`, selecting the key/Meta pair, the Meta file after its final fence changes, and the reconciliation source/arithmetic pair. No workspace-wide suite was run by this reviewer during parallel edits.

## Review observations and limits

- Meta account verification freezes observed account currency/timezone and requires new explicit enable consent. Creator token attestation is not a claim that provider token permissions were independently established. The provider surface is fixed GET URLs with bounded bytes, one page and a clipped deadline.
- A current-authority SQL proof establishes authority when that statement executes. Synchronous expiry checks cover a delayed result crossing its deadline. No finite sequence of reads can promise that a revocation occurring after the final proof has executed will erase already returned bytes.
- Reconciliation reads server-held receipt references and mappings, not client-supplied financial rows. Its source proof includes exact stored receipt/report bytes, original owner membership and frozen contract details. The current source is the separate native static-token HubSpot lane, not an OpenConnector REST/MCP credential bridge. No live reconciliation workflow has been validated.
- The Stripe Slack completed route/SQLite fixture now passes as recorded above. Live Slack delivery, installed bot permissions, provider transport compatibility and real audience configuration remain unexercised.
- Frontend private reports are cleared on expiry, scope changes and hidden-tab transitions. No live server push withdrawal of previously delivered content was tested.
- This checkpoint does not establish exhaustive coverage of every metadata/list response, frontend effect or provider error shape. Root retains the integration, global type/lint/test, migration, branch-protection and final-head checks.

## Related main-worktree hotfix review

Root temporarily redirected this reviewer to `/workspace/shiba` for v3 blockers. Independent renderer checks passed (5 cases), and seven unresolved GitHub review threads were mapped to current source and existing tests (85 backend plus 48 frontend cases passed). Threads were read only, not resolved or approved. Legacy artifact query links intentionally retain their original expiry; new links use a fragment/POST flow.

The v3 Stripe private-report session deletion race reproduced as HTTP 200 after session deletion during an earlier receipt await. A separate explicit enable probe also reproduced commitment after session deletion. The owner added exact native-session guards to human mutations and manual verification, plus combined private-report source/session SQL and synchronous expiry checks. Three new session regressions plus the original seven Stripe lifecycle/security cases passed (10 total): revoked-session verification consumes zero quota and makes zero provider calls, revoked-session enable does not commit, and private report bytes remain withheld. The scheduler retains its separate standing-grant authority. These main-worktree results are separate from v4 acceptance and from root's aggregate checks.
