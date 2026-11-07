# Legacy mutation migration: source fencing and remaining wiring

Base: PR #199 `b8e2dec5015c005a288284094dce83f26954c078`.

**Partial migration work only. Operator execution remains unavailable.** This
change hardens the existing parent participation adapter; it does not bind the
legacy routes to a production coordinator. There is no new HTTP route,
execution flag, account enrollment, secret, deployment binding or live account
access. Review-only enrollment acceptance remains review-only.

## Fixed counterexamples

Two new regression probes fail against the unchanged base:

1. `installAuthority` accepted a new generation immediately after
   `beginInvalidation`, before the source write or sibling drain completed.
   A tombstone alone was therefore insufficient to fence regrant.
2. Calling `mutateAfterOperatorInvalidation` again with the same revocation ID
   repeated its source callback, including after a successful source write and
   a lost sibling barrier reply. Its idempotent invalidation was not an
   idempotent source mutation.

The parent now blocks replacement authority while **any** incomplete revocation
references the same kind and ID. Completing a second overlapping revocation
cannot bypass the first. The check is inside the installation transaction and
survives reconstructing the parent owner.

`beginSourceMutation` atomically tombstones active references and inserts a
permanent source-write claim in the same SQLite transaction. It durably
acknowledges both before issuing the one source-write permission. Duplicate IDs,
old revocations and already-tombstoned or stale reference versions cannot issue
another permission, even when a caller supplies a different revocation ID.

The existing participation adapter uses that claim. After its callback succeeds,
it records and flushes an `applied` acknowledgment, then waits for the sibling
barrier. Callback failure, lost acknowledgments and process loss never cause an
automatic source retry. A source claim with an unresolved outcome prevents
barrier completion and regrant. The callback, owner and revocation identity are
snapshotted before the first await. No callback result or credential is stored.

A caller may retry **only** `finishInvalidation` after an acknowledged source
write. An unacknowledged source requires trusted, independent reconciliation of
the actual legacy store before `acknowledgeSourceMutation`; reissuing a write is
not reconciliation. A crash before the source callback can leave a conservative
permanent denial. The adapter deliberately prefers that availability cost to
replaying a possibly completed mutation.

The source callback must throw on failure. Legacy routines that return `false`
or `null` on failure need explicit result checks in their eventual participant;
those return values must not be mistaken for a successful source mutation.
There is no automatic generic recovery route in this prototype.

## Exact production wiring blockers

There is no parent Durable Object/runtime binding, authenticated sibling barrier
transport or durable registry mapping legacy source identities to complete
parent authority reference sets. `OperatorParentAuthority` remains a standalone
primitive, and all invocations of its install/approval writer methods remain in
tests. Adding optional callbacks to legacy routes would not resolve those
missing authorities and would create a bypass when the callback was absent.

Concrete migration inventory:

| Source | Current mutation entrypoints | Required migration boundary |
| --- | --- | --- |
| Connector credentials | `OpenConnectorIntegrationProvider.disconnect` and pinned upstream `SqlConnectionStore.writeCredential`, `updateCredential`, `delete` | Resolve every affected enrollment from the actual account/alias and source revision. The parent deny must precede the source mutation; the epoch's coordinated native owner must cover writes, scheduled work and cached applications. Never infer enrollment authority from an account label or review record. |
| Principal/token authority | `agent-tokens.ts`: `revokeToken`, `revokeApiKeyById`; pinned upstream runtime token policy/revocation | Distinguish token instances and generation from a reusable principal label. Resolve all affected principal/approval references before source mutation. KV listing or a recently refreshed token snapshot is not an authoritative registry. Treat partial-write failure sentinels as uncertain outcomes. |
| Employee/grant policy | `replaceEmployeeToolGrants`; `updateCustomAgent`, `deleteCustomAgent`, `setCustomAgentArchived`; pinned upstream runtime policy set | Cover actor, resource, role and workspace-wide changes, not only the requesting actor. Grant replacement deletes workspace/role rows that can affect other actors. All authority creation and replacement must use the same owner and source registry. |
| Human approvals | `decideEmployeeActionApproval`, `expireUnusedEmployeeActionApproval`, `claimEmployeeActionInvocation`; `recordHumanApproval` | Legacy approvals and parent execution approvals are deliberately different. Do not import legacy approved rows. Add an explicit coordinator-owned execution-approval revocation/cancellation lifecycle and immutable source mapping before wiring denial or cancellation. Preserve legacy one-shot consumption. |
| Session/run authority | Orchestrator session deletion/deleting marker, `cancelRun`, `cancelRunRecord` and cascade cleanup | Resolve the complete execution-context dependency set and durably deny it before mutation. Cover internal/cascade writers as well as public routes. |
| Review enrollment | `decideOperatorEnrollment` | Keep the existing metadata review separate. It is not execution consent and cannot authorize installing execution authority. |

The migration must also drain older parent and sibling deployments and prevent
new grants being derived from a legacy source while that source is changing.
The new claim only fences the supplied, trusted reference set; it cannot prove
that a guessed or incomplete reference set covers a credential, token or policy.
New enrollment/authority construction and source-ID mapping remain activation
gates, not work that a write wrapper can silently approximate.

No production writer was changed to claim coordinated revocation. This is an
implementation dependency, not an access denial or a permission request.

## Verification

All tests use in-memory SQLite and synthetic transport. No external account,
credential, provider operation or deployment was used.

- Parent/joint suite: **50 passed**, including 10 new source-fencing cases.
- Legacy regression suites: **100 passed across 7 files** (agent tokens,
  employee grants/store, employee approval ownership, operator account
  rejection, enrollment review, integration provider and capability invocations).
- Repository invariant suites: **76 passed, 1 failed**. The remaining
  `phase1-core-loop.integration.test.ts:612` failure expects HTTP 400 and gets
  403 for direct execution-target intake, matching the unchanged-base failure
  already recorded in the parent authority verification. Approval-before-sandbox
  itself still passes.
- Full backend production TypeScript build passed. Strict TypeScript checking
  of the changed parent/test file and its imports passed with a focused test
  configuration (the existing test config plus Node types). The final full
  backend test TypeScript program was killed with exit 137, including one
  bounded-heap retry; it is not reported as a full pass.
- Focused Biome check and `git diff --check` passed.
- Independent read-only review found no actionable fence defect.
- The two counterexample tests above fail on the unchanged base and pass with
  this patch. Other full-repository tests, native workerd cross-boundary tests,
  deployment drift/build and live acceptance were not rerun for this patch.

Commands (run from the isolated checkout):

```sh
cd apps/backend
node node_modules/vitest/vitest.mjs run test/openconnector-operator-authority.test.ts
node node_modules/vitest/vitest.mjs run test/agent-tokens.test.ts \
  test/employee-tool-store.test.ts test/employee-tool-approval-ownership.test.ts \
  test/openconnector-operator-accounts.test.ts test/operator-enrollment-reviews.test.ts \
  test/integrations-provider.test.ts test/capability-invocations.test.ts
node node_modules/vitest/vitest.mjs run test/tradeoff-contracts.test.ts \
  test/codex-subscription.test.ts test/setup-doctor.test.ts \
  test/acp-providers.test.ts test/phase1-core-loop.integration.test.ts
cd ../..
node node_modules/typescript/bin/tsc -b apps/backend
# Full test program: killed with exit 137 in this checkout.
node node_modules/typescript/bin/tsc --noEmit -p apps/backend/tsconfig.test.json
# Passed focused strict test check (temporary file removed afterward):
printf '%s\n' '{ "extends": "./tsconfig.test.json", "compilerOptions": { "types": ["vite/client", "node"] }, "include": ["test/openconnector-operator-authority.test.ts", "src/worker-types.d.ts"] }' > apps/backend/tsconfig.operator-authority-verification.tmp.json
node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit -p apps/backend/tsconfig.operator-authority-verification.tmp.json
rm apps/backend/tsconfig.operator-authority-verification.tmp.json
node node_modules/@biomejs/biome/bin/biome check --formatter-enabled=false --assist-enabled=false \
  apps/backend/src/integrations/openconnector-operator-authority.ts \
  apps/backend/test/openconnector-operator-authority.test.ts
git diff --check
```

The preinstalled dependencies were reused by local symlinks. The `pnpm` runner
attempted an unnecessary install and failed to create its default store; the
same already-installed test/typecheck/lint binaries above completed directly.
No lockfile or dependency versions were changed.
