# API-key gateway admission contract and implementation decision

Status, 2026-11-07: **disabled runtime foundations implemented; execution remains unavailable**.
The initial review below described the admission contract and counterexamples.
Shiba now includes an internal coordinated owner, permanent invocation storage,
strict envelopes, pinned API-key capture and a fixture-only fixed Figma metadata
executor. A separate generated native entry serializes requests and cron, but
always rejects the operator execution namespace with 503. There is no production
activation flag. See the [runtime verification record](verification/openconnector-coordinated-runtime-20261107.md)
for implemented scope, tests and remaining gates. The parent also has a
[generation-bound source registry](verification/operator-source-registry-20261107.md)
for atomic authority installation and complete source-resolved invalidation;
legacy production writers remain unmigrated. This supplements
[operator enrollment](openconnector-operator-enrollment.md).

## Decision

A Shiba-owned wrapper can read the real upstream revision and hold the exact
decrypted credential object. Upstream write access is not needed for those two
steps: the existing generated read entry imports the pinned storage APIs.
Therefore the missing public revision field is not, by itself, a reason a
Shiba-owned gateway is impossible.

The blocker is the **complete admission and mutation boundary**. Adding another
reserved route to the current wrapper cannot provide it. The native Worker and
parent authority stores can still change independently while final approval is
being redeemed. A safe solution requires a new coordinated runtime/deployment
boundary, not merely a metadata endpoint or adapter change. The internal executor is exercised only by fixtures; no API-key execution route
is supplied while that prerequisite is missing.

This is not a claim of fundamental impossibility. The coordinator design below
is a concrete implementation path, with explicit availability costs. Keeping
uncoordinated native writers while promising immediate, linearizable revocation
is the incompatible combination.

## Verified source boundaries

Reviewed Shiba base: `35f765f8198f0604420b3a0f3e5efe673f86bb70`, containing the
PR #199 provenance rejection on top of `fcd1404`. Upstream remains v1.9.4 at
`d89dc9f24f5a057bb500272d7dbf333837c77c68`.

1. `infra/openconnector-read-gateway.mjs` generates direct imports of
   `D1RuntimeDatabase`, `RuntimeTokenService` and `ActionPolicySnapshot`.
   `connectionStore.get(service, alias)` returns the runtime-created revision
   and decrypted credential. The wrapper can compare the actual revision and
   use the captured object without calling `/v1/actions`.
2. `packages/openconnector-read-gateway/src/gateway.ts` checks runtime policy,
   rereads the credential, then awaits `attempts.commit`, then calls `fetch`.
   There is no sibling mutation guard during that callback.
3. The pinned `SqlConnectionStore.writeCredential`, `updateCredential` and
   `delete` use D1 transactions. Credential updates advance revision, but their
   transactions do not consult a Shiba execution-admission record. The native
   retirement generation protects connection lifecycle operations; it is not a
   provider-dispatch fence.
4. Native `D1RuntimeTokenStore.updatePolicy`/`revoke` and
   `D1RuntimePolicyStore.set` issue ordinary SQL. They likewise have no shared
   dispatch fence. Token resolution also performs a best-effort `last_used_at`
   write, which must not deadlock a future mutation guard.
5. The generated entry delegates manual traffic to `upstream.fetch` and cron to
   `upstream.scheduled`. The pinned scheduled handler uses `ctx.waitUntil` for
   cleanup and trigger maintenance. The native `appCache` retains constructed
   applications and their database bindings; its key does not include a
   per-request fence or database wrapper identity.
6. Parent `claimEmployeeActionInvocation` already atomically consumes an exact
   human approval and retains `consumed_invocation_id` after receipt pruning.
   Preserve this useful one-shot boundary. It is not an atomic check of every
   current employee, resource, session and principal policy: those checks are
   performed separately in `employee-tool-routes.ts` and its store helpers.
   Agent tokens use KV; owned app sessions are read from their Durable Object;
   employee definitions and grants use D1. Repeating these reads is not a
   transaction across their mutation paths.
7. Native `D1IdempotencyStore.claim` deletes expired rows, including
   `in_progress`, before accepting a new claim. It cannot be the uncertainty
   tombstone for API-key writes.

The upstream files above are preserved, hash-checked test fixtures in
`packages/openconnector-read-gateway/test/fixtures/upstream-d89dc9.json`.
Their canonical source is
[the pinned upstream tree](https://github.com/oomol-lab/open-connector/tree/d89dc9f24f5a057bb500272d7dbf333837c77c68).
The fixtures exercise selected APIs, not the complete native Worker.

## Observed counterexamples

Four temporary characterization probes used the existing real-codec,
real-storage, real-policy SQLite fixture and a synthetic provider recorder:

- Change `connections.revision` inside the final parent `dispatch` callback:
  the existing read gateway returns 200 and calls the provider once.
- Delete the selected runtime token inside that callback: same result.
- Block the selected action in runtime policy inside that callback: same result.
- Claim a generic upstream idempotency key, leave it `in_progress`, and claim
  again after its expiry: both calls return `acquired`.

These are negative feasibility findings, not successful API-key acceptance
tests. They do not show that the current read lane executes an API key; it
explicitly rejects that auth type. They show why its current final-read pattern
and generic idempotency store cannot simply be widened to this stronger lane.
See [the reproduction and verification record](verification/openconnector-operator-admission-20261107.md).

## Required protocol

The following protocol defines the activation contract. Internal reference
modules implement portions of it; endpoint names remain unavailable in the
production application, and existing parent invalidations are not yet all
coordinated.

### 1. Immutable enrollment

Use a separate `operator_api_key` provenance discriminant, never a fabricated
OAuth consent marker. A parent-created enrollment freezes:

- Enrollment ID and generation, authenticated owner ID and server-derived
  personal alias, provider, raw account ID and upstream revision.
- Sibling deployment epoch, platform version ID, upstream source revision and
  contract manifest digest.
- Sorted exact allowed action IDs, input-schema/executor hashes and expiry.
- Operator proposal identity, authenticated owner acceptance identity and
  times, monotonic record version, lifecycle and revocation tombstone.

Derive the public connection ID by hashing a domain-separated canonical
serialization of that full non-secret tuple. The hash identifies provenance;
it never hashes credential bytes. Every identity/allowlist change creates a
new proposal and owner acceptance. Regrant creates a new generation. Account
labels and upstream row IDs alone cannot carry authority.

Exact-account metadata is obtained through an authenticated, pinned sibling
binding. It checks the underlying SQL row is a local, encrypted, active API-key
credential. The pinned storage API omits `source` on returned local objects, so
the adapter must explicitly establish local provenance rather than invent a
`source: local` assertion from caller input. No virtual/default account, OAuth,
SaaS reference, custom credential or workspace namespace is accepted.

### 2. Exact operation envelope

`POST /v1/shiba/operator-gate/execute` would accept only a strict bounded schema:

```text
format = shiba.operator-execute.v1
invocationId, approvalId, requestDigest
enrollmentId, enrollmentGeneration, connectionId
ownerId, personalAlias, provider, rawConnectionId, upstreamRevision
deploymentEpoch, versionId, manifestDigest
principalId, employeeId, employeeVersion, executionContextId
grantVersions, actionId, inputSchemaHash, arguments, argumentDigest
expiresAt, maxDurationMs, maxBytes
stage-scoped parent capability
```

The parent constructs every authority field from trusted state. Unknown fields,
duplicate JSON keys, malformed Unicode, oversized/deep inputs, caller-selected
aliases and conflicting selectors are rejected. Canonicalization and digest
versions are explicit; the digest binds every executable field, including the
schema, account generation and limits. `requestDigest` itself and opaque
capabilities/signatures are excluded from its preimage to avoid a circular
digest. Tokens, credentials and secret-derived fingerprints are
absent from this envelope and its receipts.

No operation is enabled until its API-key credential extractor, fixed host,
method/path template, bounded argument schema, response projection and failure
semantics have been separately reviewed. The first manifest must contain a
small explicit allowlist. No arbitrary URL, headers, proxy, raw query, generic
action runner, redirect or fallback is permitted. Automatic/scheduled execution
and workspace reuse remain outside this protocol.

### 3. One authoritative sibling execution owner

A conservative implementation uses one Durable Object coordinator per sibling
deployment epoch. It owns execution, not merely a lease handed back to an
uncoordinated Worker. It serializes the protected portion of all relevant
native requests, scheduled work and operator-gateway dispatch.

Before enabling it, establish all of the following:

- Every connection replacement/delete, runtime-token policy update/revoke,
  runtime-policy change and relevant configuration transition shares this
  boundary. Initially serializing whole native requests is safer than guessing
  a mutation-route allowlist.
- Native applications are constructed with a permanent coordinated storage
  boundary. Cached applications must not retain an earlier raw DB binding.
- `waitUntil`, callbacks, detached tasks, streaming continuations and maintenance
  cannot mutate authority after the coordinator releases a request. Unsupported
  background paths are disabled until their ownership is demonstrated.
- Older deployments, alternate entrypoints, Node/CLI instances and other
  database bindings cannot continue writing around the coordinator. Activation
  requires a reviewed epoch switch and drain procedure, not just a feature flag.
- No expiring mutex/lease can let a suspended former holder resume a provider
  request after a newer mutation is admitted. A larger fence number is useless
  unless the final dispatcher enforces it. Recovery must retain a terminal
  dispatch tombstone and never reissue that invocation.

Database-enforced mutation gating is an alternative: audited triggers or
constraints can make native SQL participate without modifying upstream source.
That is a real schema/deployment extension and must cover all relevant tables,
native no-op updates, token last-use writes and recovery. A lock table that
native writers ignore, or a conditional admission insert by itself, is not an
alternative.

### 4. Parent admission and revocation barrier

Introduce a parent authority coordinator for this lane. Its durable state is
the admission authority; existing policy stores are not permissive fallbacks.
All relevant parent invalidations must participate, including owner enrollment,
employee definition/version, actor/resource/role grants, principal revocation,
session deletion/run cancellation and expiry. Copying snapshots into a new
store without coordinating their invalidation is insufficient.

The order is:

1. Authenticate a scoped stored sibling runtime token with explicit action and
   raw-account grants. Admin/static secrets and empty/wildcard grants fail.
2. Under the sibling source-mutation guard, capture the exact encrypted local
   account and revision, validate current token/deployment/runtime policy, and
   completely prepare the fixed provider request. No alias re-resolution is
   allowed after this step.
3. Persist a unique invocation and complete digest before any possible provider
   effect. The claim alone does not grant permission to dispatch.
4. While retaining the sibling guard, call parent `redeem`. The parent atomically
   verifies current coordinated authority, exact frozen approval, generation,
   expiry and digest, and permanently consumes this approval for this invocation.
   Redemption binds the effective deadline: the earliest applicable enrollment,
   approval, principal/session, token and request expiry. This successful
   transition is the **admission linearization point**.
5. On an unambiguous success, the execution owner records its irreversible
   dispatch commitment, then checks cancellation and that effective deadline
   after the last awaited commitment and immediately before invoking the
   prepared request with the captured credential. Any ambiguous persistence or
   redemption result prevents a new send. There is no generic action fallback.

Revocation first atomically writes a parent tombstone, so it wins over future
redemption. It then asks the sibling for a barrier. Do not hold a parent SQL
transaction or parent-wide execution lock while waiting for this barrier; the
in-flight sibling may need parent redemption to finish. Before reporting
revocation **complete**, the barrier proves every earlier admitted invocation
has begun transport or is permanently unable to begin. Until then, report
`revoking` or `revocation_outcome_unknown`, not completed revocation.

Admission and physical HTTP issuance are different events. A call admitted
before the tombstone may begin while revocation is pending. It may already have
affected the provider even if its response never returns. Completed revocation
does not undo such effects. This two-party ordering is not presented as an
atomic transaction across two databases.

If policy demands cancellation of every call until the literal first network
byte rather than admission ordering, that stronger promise needs an execution
owner/barrier design proving it; a callback followed by `fetch` cannot claim it.

### 5. Permanent one-shot outcomes

Use distinct durable states with monotonic transitions:

```text
claimed -> rejected_before_admission
claimed -> admitted -> dispatch_committed -> completed
                                     \-> failed_definitively
claimed/admitted/dispatch_committed -> unknown
```

The complete request digest, approval consumption and invocation tombstone are
never erased by a retry TTL. Only confirmed terminal response payloads may be
pruned; retain the minimal digest and one-use tombstone. A matching replay
returns the stored receipt, `in_progress`, `unknown` or `receipt_pruned`, never
a second provider dispatch. A different digest returns conflict.

Lost parent-redemption acknowledgment, process termination, request timeout,
connection reset, malformed/oversized response and lost settlement acknowledgment
are not proof of no effect. If a dispatch might have happened, persist `unknown`.
A provider error is `failed_definitively` only if the reviewed operation's
contract proves no effect; HTTP status alone is insufficient for arbitrary
writes. There is no automatic retry, failover or new invocation under the same
approval. Status lookup cannot redeem an unknown permit. A fresh human decision
must disclose the earlier uncertain outcome, rather than silently repeating it.

Bound provider duration and bytes, reject redirects, and return only reviewed
response fields plus sanitized stable error codes. Never relay upstream auth
errors, raw headers, private credential metadata or a raw credential object.

## Acceptance gates and next implementation slices

1. Build and test the mutation coordinator, parent authority participation,
   epoch/drain protocol and revocation completion barrier first. Cover every
   current invalidation path, not just new enrollment routes.
2. Add immutable enrollment proposals/owner acceptance, generation-bound grants,
   strict operation envelopes and permanent invocation storage. Keep dispatch
   disabled until the coordinated boundary is available.
3. Add one reviewed API-key provider operation and its captured-credential
   executor. Test against a local provider recorder with fixture secrets only.
4. In race tests, pause before and after every asynchronous boundary. Exercise
   rotation under one row ID; delete/recreate; runtime-token revoke/update;
   runtime-policy change; parent grant/employee/session/principal revocation;
   expiry; duplicate calls; changed inputs/schema; lost acknowledgments; restart;
   timeout; receipt pruning; old deployment and bypass attempts. Assert both
   the response and recorder call count, including zero calls when revocation
   wins and at most one when dispatch admission wins.
5. Build and initialize the complete pinned native Worker plus wrapper in local
   workerd. Exercise native mutations, cron/background work, cache reuse,
   actual coordinator storage and service-binding transport, not only selected
   fixture modules. Separately test old/new epoch handover.
6. After explicit deployment/configuration authorization, verify one permitted
   non-mutating action against a live operator-configured account. Offline
   success is not evidence of deployment, vendor compatibility or live account
   availability.

Until these gates pass, retain the existing OAuth-only adapter and explicit
non-OAuth rejection. The next engineering work is the coordinated authority
boundary, not exposing an unsupported API-key option in the dashboard.
