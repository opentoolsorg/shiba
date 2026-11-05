# Four-priority independent security review, v3

Review date: November 5, 2026. Scope: the local six-workstream update to PR #188, starting from `1a9c692` on `feat/prince-multi-agent-control-plane`. The root agent owns the final integrated commit and aggregate checks. Preview remains paused.

This is a focused independent review, not whole-PR security coverage. CodeRabbit previously skipped the broad PR because of its size. Production fixes were made by the owning delegates; this reviewer added only the independent test files below and this evidence record. Existing fixture scaffolding is reused where needed; assertions call the actual routes, stores, cryptography and Durable Object implementations. Native login, AI, provider transports and Container allocation remain explicit fixtures.

## Reproduced findings

| Finding | Reproduction and affected production path | Resolution evidence |
| --- | --- | --- |
| Slack private draft returned after installation revocation during final authentication | `slack-coworker-routes.ts` read draft bytes, awaited native authentication, then returned the old bytes. The test revokes the installation during that authentication, verifies the committed revocation, and checks the response for the previously selected text. | Owner moved final native authentication before the guarded draft read. Independent regression passes. |
| Stripe scheduled read dispatched after revocation committed during reservation acknowledgement | `founder-stripe-runtime.ts` decrypted the key and awaited the reservation transaction; a revoked grant could then still perform a GET with the retained key. The test revokes through the real store before the transaction result resumes. | Owner added a final current grant/native/feature check before dispatch in both verification and scheduled reads. Independent scheduled-read regression passes; spent reservation remains held. |
| Stripe private report revived after workspace member removal and re-add | `founder-stripe-routes.ts` originally checked only the current membership, while execution pinned the original `owner_json`. The test completes a report, removes and re-adds its owner with higher membership versions, and attempts the same report URL. | Owner added frozen source membership checks to report reads and activation. Independent route regression passes. Current-owner cleanup remains available. |
| Positive Stripe database proof arrived after its lease expired | Root identified the missing synchronous time fence. Independent tests hold the real successful SQL proof, advance the clock beyond expiry and release the proof. Account verification and scheduled reads still performed fixture GETs; the report route still returned bytes. | Owner added synchronous checks after the last await and before provider dispatch/report return, clipped provider timeout to the remaining grant lease, and checked receipt expiry. All four probes pass, including a receipt that expires before its grant. |
| Stripe pane stuck busy during React StrictMode effect replay | `FounderStripeReads.tsx` retained the aborted first effect's pending latch, preventing the second initialization and leaving review/refresh/close unavailable. | Owner made the pending latch belong to its effect AbortSignal. The independent StrictMode regression now passes; older requests cannot clear a newer request’s latch. |

All five findings were observed as failing adversarial tests before owner fixes. An intermediate Llama quote-construction typo was also reported and corrected before final model checks. Initial test-fixture mistakes (oversized single ledger seed, assertions bypassed by a mocked implementation, invalid Slack state enum, and subsecond scheduler timing) were corrected and are not production findings.

## Independent evidence

| Test file | Cases | Boundary exercised |
| --- | ---: | --- |
| `apps/backend/test/team-model.security-v3.test.ts` | 7 | Distinct grants competing at the exact requester/workspace ceiling; confirmed and unknown historical debits; orphaned workspace ledger history; transaction rollback on failed reservation insert; exact frozen Llama payload; 5,158 microUSD maximum reservation and 2 microUSD quoted 1-input/1-output usage; absent provider identity remains null; missing usage or conflicting model holds the entire debit without retry. |
| `apps/backend/test/shared-computer.security-v3.test.ts` | 4 | Named viewer can capture but cannot obtain an unreviewed control lease; in-flight JPEG is withheld after STOP, viewer removal or native-account deletion; only one fixture allocation occurs. |
| `apps/backend/test/slack-coworker.security-v3.test.ts` | 6 | Concurrent challenge confirmation consumes once; immutable UUID binding; signed duplicate-user rejection; installed identity cannot invoke provider/model/approval effects or add native membership; Slack-side principal disclosure and explicit same-user acceptance prevent planted-code binding; final read revocation fence. |
| `apps/backend/test/output-archive.security-v3.test.ts` | 5 | Concurrent final room-slot reservation; revoked leases retain quota; tampered signed job/epoch/digest cannot append or advance ACK; valid old-epoch proof after source replacement cannot advance ACK or issue START. |
| `apps/backend/test/founder-stripe.security-v3.test.ts` | 9 | Ciphertext cannot cross workspace, native UUID, credential ID, revision, Stripe account, mode or expiry; fresh encryption and tag/key rejection; strict invoice projection drops nested PII, links and instructions. |
| `apps/backend/test/founder-stripe-lifecycle.security-v3.test.ts` | 7 | Real SQLite reservation/revoke dispatch race; competing ticks and unknown no-retry; real private report route denies source removal/re-add; held final positive proofs cannot authorize verification, dispatch or report bytes after grant/receipt expiry. |
| `packages/openconnector-read-gateway/test/upstream-adapter.security-v3.test.ts` | 11 | Pinned upstream encrypted-store/token/policy APIs; new Figma comments cannot inherit API-key or metadata-only grants; injected additional configuration cannot override endpoint/authentication; unsupported Stripe/Meta operations remain rejected in this gateway; Google Ads pins exact developer-token/source-revision fingerprint and separately provisioned fingerprint key; missing/changed pins block fetch; reviewed account IDs and compiled bounded query reach only the fixed endpoint; developer credential is redacted; unrelated scoped tokens cannot attest. |
| `apps/frontend/src/components/FounderStripeReads.security-v3.test.ts` | 1 | Actual React component effect replay must leave grant management usable. |

Scoped rerun on November 5 at 10:10–10:11 UTC: **46 passed** across eight files (34 backend, 11 gateway, one frontend). A later root-requested lease audit added four cases; the expanded seven-case Stripe lifecycle file passed at 10:14 UTC after fixes, superseding its earlier three-case result. The final independent set therefore contains **50 passing cases** (38 backend, 11 gateway, one frontend), with no skipped tests in these scoped commands. All five finding regressions passed. No remaining blocker was reproduced within these tested boundaries. Changes after this local checkpoint require their own checks; root records the final commit and aggregate result.

The scoped commands are:

```sh
pnpm -C apps/backend exec vitest run test/team-model.security-v3.test.ts test/shared-computer.security-v3.test.ts test/slack-coworker.security-v3.test.ts test/output-archive.security-v3.test.ts test/founder-stripe.security-v3.test.ts test/founder-stripe-lifecycle.security-v3.test.ts
pnpm -C packages/openconnector-read-gateway exec vitest run test/upstream-adapter.security-v3.test.ts
pnpm -C apps/frontend exec vitest run src/components/FounderStripeReads.security-v3.test.ts
```

The gateway fixtures load the checked-in pinned upstream source blobs with the real selected encryption, SQLite, token and policy implementation; unrelated upstream capabilities throw if called. The fake provider responses do not prove provider permission, account ownership, API availability or real quota behavior. The Stripe restriction attestation and restricted-key prefix do not independently prove the provider-side key's permission settings.

## Reviewed limits and omitted live flows

- Slack linking and future self-authored thread drafts confer no private-channel history, membership, provider credentials, payer or autonomous approval authority. Native draft adoption still requires the normal separate human execution flow. Installed Slack signatures, OAuth and event delivery were not exercised live.
- Funding tests exercise application reservations, not invoices, payments, real Workers AI inference or provider-wide spending. Missing usage remains unknown. Provider IDs absent from a binding response are not invented.
- Computer tests use actual production DO/SQLite and authorization code with a fake Container transport. They do not establish Cloudflare allocation, a real shared display, browser image behavior or controller transport latency.
- Archive tests prove bounded admitted retained output and ACK/epoch fences. They do not restore process memory, uncommitted files or unacknowledged bytes. The recovery owner's actual workerd/TCP replacement drill is separate evidence; this reviewer did not rerun it.
- Stripe uses a separate default-off restricted-key contract. Its tests do not create or validate a real Stripe key/account. Fixed-window bounded rows do not establish dataset completeness, MRR, churn or reconciliation. Stripe reports remain separate from automatic Slack delivery.
- Google Ads review covers the source configuration/attestation boundary and pinned adapter fixtures. The owner's full parent permit/prepare/dispatch test is separate evidence. No real Google Ads account, developer-token permission, quota or endpoint acceptance was exercised.
- No full workspace test suite, browser acceptance campaign, deployed-preview validation, production deployment, merge, external message, real provider call or credential provisioning was performed by this reviewer. Root integration owns final typecheck/lint/build/aggregate test results and exact commit attribution.
