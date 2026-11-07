# Parent operator authority prototype verification

Base: PR #199 `d312707acc10fe1c72371915780fcfdd7c1c31b4`.

This is an isolated, fixture-tested implementation of the parent half of the
[coordinated admission contract](../openconnector-operator-gateway-contract.md).
**API-key execution remains unavailable in the deployed application.** There is
no new public route, Durable Object binding, feature flag, credential, migration
of existing approvals, account enrollment, deployment or provider-account test.

## Implemented boundary

`OperatorParentAuthority` owns seven kinds of versioned authority: enrollment,
employee, principal, execution context, actor grant, resource grant and role
grant. A frozen human approval records every required dependency and the exact
request digest. Grants must match the complete envelope set and the approved
principal, employee, account and action. Missing authority never falls back to
legacy D1, KV or session reads.

A synchronous SQLite transaction verifies all current authority, version and
expiry fields, consumes the immutable approval, and inserts the permanent
admission. Explicit storage durability acknowledgment precedes the successful
response. The effective deadline is the earliest request, approval, capability,
runtime token or authority expiry. Duplicate redemption returns uncertainty,
never another dispatch permit. The consumed approval survives admission receipt
pruning and process reconstruction.

The non-secret connection ID hashes the complete strict execution enrollment
tuple: owner, personal alias, account and revision, deployment identity, pinned
upstream source, operation/schema/executor hashes, expiry, operator proposal,
authenticated owner execution acceptance, record version, generation and active
lifecycle. Regrant requires a new generation, proposal and execution acceptance.
The review-only UI's acceptance is intentionally incompatible and cannot be
promoted to execution consent. Stage-scoped HMAC capabilities use an existing
parent-owned CryptoKey; helpers do not create or persist signing credentials.

Invalidation writes and durably acknowledges a tombstone before the caller can
mutate a legacy source. It derives affected sibling epochs from frozen approval
dependencies, then waits for exact epoch-and-revocation-ID barrier responses
without holding a parent transaction or parent-wide execution lock. Failures
retain `revoking` or `revocation_outcome_unknown`. A completed barrier is monotonic.
Source write failure leaves authority denied; uncertain tombstone persistence
prevents the source write entirely.

## Verification

The parent test file covers 40 cases, including joint tests using the actual
sibling `OperatorGateway`, `CoordinatedOwner` and permanent invocation store.
SQLite databases are real in-memory SQLite; provider transport is a synthetic
recorder and every credential value is a fixture.

- Exact immutable approval, every required authority kind and grant dependency.
- Revocation and expiry while capability verification is awaiting.
- Duplicate/concurrent redemption, lost commit acknowledgment and restart.
- Pruned admission rows without loss of approval consumption.
- Immutable full enrollment provenance and distinct review-only consent.
- Stage, invocation, digest, approval, deployment and HMAC-key mismatches.
- Durability acknowledgment failure before admission or source mutation.
- Barrier timeouts, wrong epochs/nonces, restart recovery and monotonic completion.
- Joint zero-provider behavior for missing/revoked parent authority.
- Tombstone-before-redemption without a parent/sibling deadlock.
- Admission-before-tombstone: barrier stays pending while the last sibling
  dispatch commit is held; the already-admitted call may begin transport before
  revocation completes. This does not claim literal-first-byte cancellation.
- Lost parent acknowledgment leaves both stores uncertain with zero provider calls.

Commands:

```sh
pnpm -C apps/backend test test/openconnector-operator-authority.test.ts
```

Focused strict TypeScript checking and Biome checking cover the three new
production modules and test file. The full backend production TypeScript build and test TypeScript check pass after linking the existing
workspace dependencies. An eight-file regression run passed 119 of 120 tests:
the unchanged base has the same `phase1-core-loop.integration.test.ts:612`
failure, expecting 400 but receiving 403 for direct execution-target intake.
The approval-before-sandbox test itself passes. Built-site docs validation was
not available in this independent checkout because `public/` has not been
built; the new relative documentation link resolves.

## Subsequent mutation-fence hardening

The [legacy mutation migration record](operator-legacy-mutation-fences-20261107.md)
documents permanent source-write claims, blocked regrant until completed
revocation, restart/race coverage and the precise remaining writer mappings.
Production route integration remains incomplete.

## Activation blockers and deliberate limits

`OPERATOR_PARENT_PRODUCTION_READY` is the literal `false`. There is no runtime
route that accepts these internal writer methods. The implementation is not a
claim that all existing invalidations participate today.

Before activation, integrate and verify all existing owner/employee definition,
actor/resource/role grant, principal-token, session deletion and run-cancellation
writers through the authority owner. The participation adapter exists, but
legacy stores are not silently wrapped by this change. New grants and human
execution approvals must originate in this coordinator after authenticated
owner consent and pinned sibling attestation, not by copying review tables or
periodically refreshing policy snapshots. Drain legacy writers/older parent and
sibling deployments; bind the service identity, epoch and barrier transport; and
complete native-worker and cross-boundary integration review. Expiry is checked
inside admission and again by the sibling immediately before transport.

These requirements are an activation gate, not a claim of production parity.
Existing OAuth/read/manual paths and `claimEmployeeActionInvocation` are unchanged.
