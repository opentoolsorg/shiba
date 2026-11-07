# Operator-enrolled non-OAuth accounts: design and blocked prerequisite

Status: **not enabled**. This is a design for a separate, bounded API-key lane,
not evidence of working non-OAuth execution. No account was enrolled, no secret
was configured, and no deployment was performed. Existing OAuth checks and the
OAuth-only scheduled-read gateway remain in place.

## Confirmed gap at Shiba PR #199 head `fcd1404`

Shiba lists non-OAuth services in the catalog, but cannot safely execute their
operator-configured accounts. The manual adapter requires a completed
`oauthAuthorizationId` to make an account execution-ready. Employee grants bind
the resulting exact connection ID, and every invocation still needs the current
principal/resource grants and exact-action human approval. A configured API-key
account is not an OAuth consent receipt.

The sibling is pinned to OpenConnector v1.9.4 commit
`d89dc9f24f5a057bb500272d7dbf333837c77c68`:

- [Stored connection and generation](https://github.com/oomol-lab/open-connector/blob/d89dc9f24f5a057bb500272d7dbf333837c77c68/src/server/storage/connection-store.ts):
  `writeCredential` and `updateCredential` generate a fresh `revision`, while an
  existing row retains its `id` when its credential changes.
- [Public connection summary](https://github.com/oomol-lab/open-connector/blob/d89dc9f24f5a057bb500272d7dbf333837c77c68/src/connection-service.ts):
  `ConnectionSummary` and `createStoredConnectionSummary` expose the auth type,
  row ID and profile, but do not expose the stored revision. Only OAuth
  credentials expose `oauthAuthorizationId`.
- [Runtime action boundary](https://github.com/oomol-lab/open-connector/blob/d89dc9f24f5a057bb500272d7dbf333837c77c68/src/server/api/runtime-execution-routes.ts):
  `/v1/actions/:actionId` accepts alias and `x-oo-connector-app-id`; it does not
  accept or enforce an expected credential revision.

Consequently, hashing the account ID, profile or alias, adding a Shiba-local UUID,
or accepting a caller's claimed generation cannot distinguish an in-place
credential rotation. A metadata read immediately before the generic action POST
also leaves a race between that read and credential resolution. Sending an
invented conditional header to the existing route would not fix this: the pin
ignores it. Do not enable this lane using those shortcuts.

## Implemented safe boundary

The adapter now refuses explicitly non-OAuth auth types even if malformed
metadata contains an OAuth marker. Existing OAuth responses that omit authType
still require the existing runtime-owned authorization marker. API-key and
custom-credential inventory rows explicitly report that version-pinned operator
enrollment is unsupported, and cannot enter OAuth reconnect. They are excluded
from execution-ready listings, employee grants and action dispatch.

`apps/backend/test/openconnector-operator-accounts.test.ts` covers these cases
with synthetic account metadata and SQLite employee policy storage. It proves
rejection, not successful vendor/API-key execution. Existing OAuth, employee
approval and revocation fixtures remain separate regression gates.

## Implemented owner review foundation

The optional personal dashboard review panel and `/api/operator-enrollment-reviews`
route store and review **non-executable metadata only**. They default off with
`OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED=false`. Apply migration
`0037_operator_enrollment_review.sql` before explicitly enabling this review UI.
Changing this flag cannot enable non-OAuth actions. The adapter rejection above
is unchanged.

The first review surface is limited to the current verified native bootstrap
owner, not invited accounts, Access-only sessions, bearer principals or workspace
accounts. Owner account identity, verification and the exact live native session
are checked again inside each D1 read/decision statement. Decisions use the exact
proposal digest and optimistic version. Account/generation/provenance fields
are immutable; transitions cannot reactivate a rejected or revoked record, and
revocation tombstones cannot be deleted through this store. Regrant requires a
new proposal and generation. The public DTO contains no credential value or
owner session identifier. Directory responses name the authenticated actor and
native account. The panel checks the displayed actor, pins that native account,
and includes the exact account pin in every decision; a cookie/account switch
cannot silently adopt another owner. The panel shows the latest 100 proposals and clears
stale responses and review choices when the displayed owner changes.

There is intentionally **no proposal ingestion route** yet. The internal
`proposeOperatorEnrollment` seam has no production caller: a future caller must
authenticate the operator and fetch exact attested metadata from the coordinated
sibling. Browser-provided metadata, revision claims or labels cannot stand in
for that source. Do not seed a production record manually to imply attestation.
The schema rejects unknown credential, owner and OAuth-marker fields, but it is
not a secret detector. The future trusted ingestion boundary must project only
the declared non-secret metadata.

`proposed → accepted` records that the owner reviewed the immutable proposal.
It never creates a connection, employee grant, invocation approval or active
state. The schema fixes `executionAvailable` to false. Reject and revoke are
explicit decisions; revocation leaves the upstream credential untouched. A
known proposal can still be revoked through the exact decision endpoint after
the review flag is disabled. The disabled directory is hidden and does not read
the optional table. This is a metadata tombstone only, **not** the coordinated
runtime revocation barrier required below. No runtime may treat this review
snapshot as current execution authority.

## Proposed first scope

Implement only manually approved personal `api_key` accounts for an explicit
small provider/action allowlist. Keep `custom_credential`, workspace sharing,
marketplace, SaaS references, default/virtual accounts, no-auth, arbitrary HTTP
proxying, raw-query escape hatches and automatic/scheduled execution unsupported
until their own requirements are reviewed. Do not add secrets to action schemas,
chat, containers, browser forms in Shiba, enrollment records or logs. The
operator enters credentials only into OpenConnector's existing protected flow.

Enrollment and execution are distinct authorities:

1. The operator selects an existing encrypted, local API-key account in the
   sibling and proposes that exact account revision for a named Shiba owner.
   The parent derives the personal alias from authenticated identity; neither a
   model nor a browser-supplied alias can select someone else's account.
2. The authenticated owner reviews a bounded proposal containing provider,
   account label, exact enrollment generation, expiry and allowed action IDs.
   This accepts account use, not every future action. Operator access alone
   cannot grant an employee use of another person's account.
3. Existing employee policy configuration grants an exact principal, employee
   version, provider/resource, capability and enrollment generation. No wildcard
   principal, resource or account fallback; discovery and execution remain
   separate capabilities.
4. Each call freezes exact action ID, arguments and their digest, grant versions,
   enrollment generation and expiry into the existing human approval record.
   Approval is one-use and does not silently authorize changed arguments.

## Required sibling contract

The follow-on [gateway admission review](openconnector-operator-gateway-contract.md)
confirms that a Shiba-owned wrapper can obtain the real revision without
modifying upstream source. It also reproduces the remaining mutation and
idempotency races, and specifies the coordinated runtime boundary required
before this proposal can safely execute an API-key action.

Add a reserved namespace on the sibling, isolated from the generic action
executor and the scheduled-read gateway. Both sides default disabled. Pin the
reviewed sibling deployment version and contract digest through a trusted
service binding, following the existing read-gateway attestation pattern. A
failed capability check must return unavailable, never fall back to `/v1/actions`.

The metadata contract returns a non-secret, runtime-derived revision only for one
exact owner alias/service/raw account ID. It requires authenticated operator
access and must not enumerate or export credential values. Verify encrypted
storage, `source=local`, `authType=api_key`, configured/active state and an explicit
allowlist. Never derive a revision by hashing credential values or expose a
credential fingerprint that permits offline guessing.

The execution contract must:

- Accept an exact frozen generation tuple, approved operation/input digest,
  single-use permit, expiry and request ID. Reject unknown fields, oversized
  bodies and aliases outside the approved personal namespace.
- Authenticate a scoped runtime token with explicit action and raw connection
  grants, plus current deployment/runtime policy. Empty and wildcard grants are
  not restricted grants. Admin tokens must not be execution fallbacks.
- Resolve one exact stored connection and check its revision against the approved
  tuple. Use that captured credential object for the bounded provider request;
  never re-resolve by alias through the generic action runner after checking it.
- Recheck the live revision and policies after asynchronous preparation, and
  redeem current parent authority immediately before dispatch. Revocation and
  rotation must share an admission fence with dispatch: whichever transition
  wins admission defines the result. A revocation after a provider request has
  already begun cannot undo that request, and must not be reported as doing so.
- Bind a durable one-use claim to the complete request digest. Replays return the
  stored result without another provider call; mismatched digests conflict.
  An interrupted or uncertain provider write stays `unknown` and is never
  automatically retried. Bound provider duration, redirects, response bytes and
  permitted host/method/path; do not expose an unbounded proxy route.
- Return a sanitized receipt with the enrollment generation and invocation ID.
  Suppress credentials, upstream auth errors and raw credential metadata in all
  parent-visible output and audit records.

Adding metadata alone is insufficient. The upstream revision and exact captured
credential must be enforced where the provider dispatch occurs. Any wrapper
needs pinned-source integration fixtures and a complete local Worker bundle test
before it can be described as compatible with the unmodified sibling pin.

## Parent persistence and transitions

Use a separate discriminated provenance type, never a fabricated
`oauthAuthorizationId`. An enrollment record freezes:

- Enrollment ID, server-created immutable generation, provider, raw account ID,
  upstream revision, authenticated personal owner ID and derived alias.
- Sibling deployment/version and contract digest, permitted action IDs and
  expiry. All identity fields become immutable after proposal creation.
- Operator proposal identity, owner decision identity, creation/decision time,
  state and optimistic-concurrency version. No secret fields.

A domain-separated connection ID includes the entire generation tuple. Bind
employee/resource grants, approvals and receipts to that ID. Keep a monotonic
revocation tombstone for each generation. Proposed → accepted → active is
allowed only after owner acceptance and fresh sibling attestation. Any change
of account ID, credential revision, owner, alias, allowlist, deployment or
contract requires a fresh proposal, acceptance and grants. No UPDATE that
silently repoints an active generation.

Revocation first prevents new parent admission and invalidates pending/approved
calls, then closes the matching sibling admission fence. Regrant creates a new
generation. Disappearance, rotation, expired enrollment, revoked runtime token,
changed principal/employee grant or uncertain sibling outcome fail closed.
Operator credential deletion is a separate explicit action, not an automatic
side effect of revoking employee authority. Personal enrollment cannot become a
workspace connection by changing its scope; sharing requires separate owner and
workspace-administrator authorization and a distinct namespace/generation.

## Acceptance tests before enabling execution

Use fixture-only credentials and a local provider recorder. Cover positive
owner enrollment → principal/resource grant → human approval → one dispatch;
no approval, wrong owner/alias/service/raw ID, ambiguous account, borrowed OAuth
marker, missing runtime grants, revoked enrollment and revoked employee/actor
policy all produce zero provider calls. Test rotation under the same row ID both
before approval and while final preflight is paused; old grants and approvals
must be unusable. Exercise revoke/readmit races, expiry after awaits, cancelled
runs, replay and lost acknowledgment, changed input/schema, malformed attestation,
wrong deployment, attempted workspace reuse, and secret-bearing upstream errors.

The first successful deployment requires explicit operator configuration and
separate live verification using a permitted non-mutating provider action.
Fixture success is not proof of a configured account or vendor availability.

## Local verification, 2026-11-07

- 126 backend cases passed across nine files: operator-account boundary (12),
  OpenConnector adapter/catalog/routes/HTTP, employee OpenConnector preflight,
  employee-tool routes, workspace integrations and repository tradeoff contracts.
- Backend source/project TypeScript and test TypeScript passed. Changed-source
  ESLint passed; focused Biome passed with two pre-existing adapter warnings and
  no warnings in the new test file. `git diff --check` passed.
- Independent code/design review reported no remaining blocker after explicit
  zero-dispatch assertions were added outside the fixture transport functions.
- Full repository build/aggregate gates were not run. `scripts/check-docs.mjs`
  could not run because this isolated checkout has no generated `public/` build
  output. No live API-key account, production credential, provider request,
  deployment, or complete new enrollment path was exercised.
