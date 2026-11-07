# Authoritative source registry and migration prerequisites

Base: PR #199 `ba15e04540b4a24350d000e1a0249559019050bb`.

**Disabled, fixture-tested prerequisite only.** No legacy writer or public route
has been migrated, no production parent binding or activation flag was added,
and no live account, credential, network provider, deployment or remote push was
used. `OPERATOR_PARENT_PRODUCTION_READY` remains the literal `false`. This work
continues the [source mutation fences](operator-legacy-mutation-fences-20261107.md)
and [parent authority](openconnector-parent-authority-20261107.md).

## Implemented boundary

`openconnector-operator-sources.ts` stores generation-bound source identities and
their complete registered authority dependency sets in the **same SQLite owner**
as authority, approvals, admissions and revocations. `installAuthority` now has a
mandatory source-reference argument. It validates and creates the authority and
all of its mappings in one synchronous transaction. There is no separate
attach-mapping call, optional callback, post-commit indexing task or fallback to
legacy policy reads. Approval creation and redemption also require current,
complete source mappings.

`beginSourceMutation` and `mutateAfterOperatorInvalidation` now accept source
instances, **not authority-reference subsets**. In one transaction the owner:

1. Validates every exact source key and generation.
2. Resolves all registered current dependencies, including other actors and
   authority owners using the same shared policy. It does not truncate a bulk
   mutation to the approval envelope's 32-dependency limit.
3. Marks every affected source `changing`, even if no authority uses it yet.
4. Tombstones the complete resolved authority set, derives affected sibling
   epochs, and inserts a permanent one-shot source-write claim.

`lookupLegacySource` resolves an exact physical identity to its non-secret
current generation metadata. It is a detached read snapshot, never a permit;
the mutation transaction still compares the generation and current source state.

Only after durable acknowledgment may the source callback run. A different
revocation ID cannot replay the same source generation. Restart, failed callbacks
and uncertain durability keep the denial. A callback must still throw on legacy
`false`/`null` failure sentinels. No generic callback result or credential is
persisted. The existing sibling completion barrier and uncertain-outcome rules
remain in force.

A completed revocation does not automatically reactivate a source. The trusted
writer must independently establish the new source state and call
`advanceLegacySource` with the exact next generation after the source write and
all barriers complete. Old references remain stale, and a duplicate or skipped
generation is rejected. Authority must then be freshly installed with its own
version, consent and provenance checks. This is not automatic retry or regrant.

## Physical identities, not authority labels

| Source kind | Stable physical key | Required mapping |
| --- | --- | --- |
| Connector account | Canonical credential `storeId`, personal alias and provider | Enrollment. Raw row ID and upstream revision are generation metadata and must match immutable provenance. |
| Principal token | Canonical KV/token `namespaceId` and non-secret token instance handle | Principal. Its parent principal ID must be the stable token-instance handle, not a reusable display/principal label. |
| Employee definition | Workspace ID and employee ID | Employee authority. |
| Employee grants | Workspace ID and employee ID | Every actor/resource/role authority built from that shared policy. Never partition by requesting actor or authority owner. |
| Session | Authenticated owner ID and session ID | Execution context, together with its run. |
| Run | Authenticated owner ID and run ID | Execution context, together with its session. |

A credential slot does **not** include deployment epoch or raw row ID in its key.
Otherwise an old/new deployment or delete/recreate would split the same mutation
fence. The row ID and actual native revision live in registered generation
metadata; all enrolled runtime epochs are included in barrier fanout. Shared
workspace policy likewise does not include the requesting authority owner in
its physical key.

Only the trusted coordinator may construct these identities. `storeId` and
`namespaceId` must be fixed, canonical identifiers for actual storage bindings,
not caller-selected names or fresh aliases for the same backing store. Source
registration is not proof that a writer is authentic, that a native account
exists, or that a snapshot is complete. Future production participants must
establish those facts from their real mutation/creation paths.

## Migration refusal and deployment prerequisites

The private registry schema is initialized only for an empty parent store. A
populated older prototype with no registry marker stays denied, including when
only permanent admissions/revocations/source claims survive. Unknown formats,
missing mappings and stale generations also deny. There is intentionally no
backfill from legacy grants, approvals, enrollment-review rows, KV enumeration
or periodic snapshots. A schema marker is not an activation switch.

Before this can become a production boundary:

1. Provision one authenticated parent owner and canonical physical store/token
   namespaces. All authority creators and relevant mutations must use it;
   independent registry instances for the same source are unsafe.
2. Drain older parent and sibling deployments and alternate native/CLI/database
   writers. Establish a fresh, reviewed epoch without copying old permissive
   approvals or authority into this registry. Preserve permanent old invocation,
   approval-consumption and uncertainty tombstones; never use a new epoch to
   replay an old human approval.
3. Add coordinator-owned creation paths for real execution enrollment, all
   seven authority kinds and exact human approvals. Owner review acceptance is
   still not execution consent. Source IDs and complete run/session scopes
   must come from authenticated server state, not model or request fields.
4. Give every token a durable non-secret instance identity and exact lookup from
   each revoke path. Legacy MCP tokens currently lack the required durable
   public instance index. API-key `keyId` revocation can cover multiple stored
   rows; its coordinator participant must resolve all corresponding instances
   without relying on eventually consistent KV listing as an authority index.
5. Migrate credential replacement/disconnect, token policy/revocation,
   `replaceEmployeeToolGrants`, employee update/archive/delete and internal
   session/run cancellation/cascade writers. Verify their exact physical
   target scopes, result sentinels and source acknowledgment. Bulk operations
   must cover every affected source, not merely the source named by the actor.
6. Add explicit immutable human-execution-approval cancellation/revocation.
   Legacy approval denial, expiry and consumption are not imported and are not
   claimed to participate in the new registry.
7. Bind authenticated sibling epoch/barrier transport and the complete pinned
   native Worker, including scheduled/background work, cached applications,
   restart and old/new epoch handover. Test actual Durable Object storage and
   service binding, not just in-process SQLite fixtures.
8. Complete deployment review and obtain separate configuration/deployment and
   live-account authorization. No offline result proves live availability.

The registry enforces all dependencies created through its installation API.
It cannot prove that an unintegrated legacy route, a newly invented storage alias,
or an external writer participates. Those are explicit activation blockers,
not facts inferred from the tests. Existing OAuth/read/manual execution paths
and legacy one-shot approval consumption are unchanged.

## Verification

Fixture credentials and synthetic provider recorders only:

- Parent/registry/joint suite: **75 passed**, including 25 additional cases.
- Seven targeted legacy suites: **100 passed** (tokens, employee grant/store,
  employee approval ownership, operator account rejection, enrollment review,
  integration provider and capability invocations).
- Repository invariants: **76 passed, 1 failed**. The existing
  `phase1-core-loop.integration.test.ts:612` direct-intake case expects HTTP 400
  and receives 403, independently reproduced on the unchanged `ba15e04` base. Approval-before-
  sandbox itself passed.
- Full backend production TypeScript build, focused strict test TypeScript,
  focused Biome, changed production ESLint and `git diff --check`: **passed**.
  The test file is excluded by the ESLint configuration; its Biome check passed.
- Independent read-only review identified epoch-scoped credential identity and
  owner-scoped shared-grant identity gaps. Both were fixed and regression-tested;
  re-review found no remaining actionable defect within the unbound trusted-
  coordinator scope.

New cases cover missing mappings and incompatible legacy callers, bulk fanout
beyond 32 references, other actors/owners, cross-epoch credential fencing,
delete/recreate, unused sources, stale generations, failed multi-source
transactions, partial-map rollback, callback/commit/advance acknowledgment loss,
source mutation racing asynchronous enrollment validation, canonical key order,
strict field rejection, session and run fanout, restart, old/unknown schemas,
and real sibling admission/barrier races with zero or at most one provider call.

Full-repository build/lint/test aggregates, full backend test TypeScript,
built-site documentation validation, complete workerd cross-boundary tests and
live acceptance were not run for this change. The backend tests used the
existing installed dependencies via local symlinks; no dependencies or lockfiles
changed.

```sh
cd apps/backend
node node_modules/vitest/vitest.mjs run test/openconnector-operator-authority.test.ts
node node_modules/vitest/vitest.mjs run test/agent-tokens.test.ts \
  test/employee-tool-store.test.ts test/employee-tool-approval-ownership.test.ts \
  test/openconnector-operator-accounts.test.ts test/operator-enrollment-reviews.test.ts \
  test/integrations-provider.test.ts test/capability-invocations.test.ts
node node_modules/vitest/vitest.mjs run test/tradeoff-contracts.test.ts \
  test/codex-subscription.test.ts test/setup-doctor.test.ts test/acp-providers.test.ts \
  test/phase1-core-loop.integration.test.ts
cd ../..
node --max-old-space-size=1536 node_modules/typescript/bin/tsc -b apps/backend
# Temporary focused config extends apps/backend/tsconfig.test.json, adds Node
# types, and includes the parent authority test plus src/worker-types.d.ts.
node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit \
  -p apps/backend/tsconfig.operator-registry-verification.tmp.json
node node_modules/@biomejs/biome/bin/biome check --formatter-enabled=false --assist-enabled=false \
  apps/backend/src/integrations/openconnector-operator-authority.ts \
  apps/backend/src/integrations/openconnector-operator-sources.ts \
  apps/backend/test/openconnector-operator-authority.test.ts
git diff --check
```
