# Personal execution for invited team members

Status: blocked on a later product and authorization contract. This extends the
team employee request; it is not a prerequisite from the original four-phase
control plane plan. No invited-member execution is enabled by this document.
The current API denial is intentional and must remain until the contract below
is implemented and verified.

## Current boundaries

- [`team-member-auth.ts`](../apps/backend/src/team-member-auth.ts) denies invited
  native accounts access to deployment provider setup, computers, run intake and
  approval administration. [`runs-routes.ts`](../apps/backend/src/runs-routes.ts)
  separately rejects their collaboration employee execution requests.
- [`model-connections.ts`](../apps/backend/src/model-connections.ts) defines
  connections as `owner: "deployment"`. A missing connection selection can adopt
  the sole ready connection or implicit deployment default in
  [`model-policy.ts`](../apps/backend/src/model-policy.ts). A personal route must
  not inherit either behavior.
- Pairing in [`computers-routes.ts`](../apps/backend/src/computers-routes.ts)
  signs a nonce and expiry. [`local-dispatch.ts`](../apps/backend/src/local-dispatch.ts)
  stores the nonce expiry and paired machine token hash, without a human owner
  or workspace grant. The current fleet list and Claude readiness probe inspect
  the deployment fleet. Machine pinning proves freshness and harness support,
  not ownership. Every paired daemon can currently claim unpinned pending work.
- [`shiba-local-daemon.mjs`](../scripts/shiba-local-daemon.mjs) inherits the
  selected provider's local API key when present and
  [`link-operator-auth.mjs`](../scripts/link-operator-auth.mjs) copies both Claude
  and Codex login files into a disposable run home. CLI presence in a heartbeat
  proves neither the account nor the effective API-key/subscription billing
  lane. These are existing single-operator paths, not a personal team grant.

## Existing inference and outbound cost paths

Direct `POST /api/runs` queues a frozen human approval without invoking the
coordinator model. This does not make all resulting work free of operator-funded
inference or external data processing.

| Path | Current trigger and funding boundary |
| --- | --- |
| Coordinator | `CodingOrchestrator.getModel()` selects the operator's Workers AI model for conversational turns. A local child account does not change the parent model. |
| Publication Reviewer | A completed deferred publication proposal creates a durable read-only review before publication approval. `ReadonlySpecialistAgent` invokes `env.AI` for a nonempty diff. This does not run for every ordinary non-publishing task. |
| Explicit specialists | Explorer and Reviewer tools use the same operator Workers AI binding when invoked. |
| TypeSafe intake triage | `orchestrator.ts` calls `evaluateSessionTriage` for a new repository run whenever `TYPESAFE_API_KEY` is configured, including local and shared-room runs. It sends the task and repository. |
| TypeSafe quality grading | A completed run calls `evaluateResultQuality` when that key is configured, including local and shared-room runs. It sends an output excerpt. |
| Memory distillation | Ordinary completed/error personal runs can call `env.AI` when `MEMORY_ENABLED` is enabled. `dispatchSessionDistill` explicitly skips collaboration handoffs; preserve that privacy boundary. |
| Chained PR review | Requires a completed PR plus an approved `reviewAfterPublish` choice or enabled review loop in [`review/chain.ts`](../apps/backend/src/review/chain.ts). It is separate from the publication Reviewer. |

The local CLI runs against credentials on the selected machine. Worker CPU,
Durable Object, D1, private artifact storage and network costs still belong to
the operator unless a separate hosting arrangement exists. Personal provider
selection must never be presented as eliminating those infrastructure costs.

## Smallest proposed execution slice

An explicitly submitted shared-room repository task could run on the requesting
human's own paired Claude or Codex machine. The initial slice should allow only
direct submission, human approval, local execution and source-authorized result
delivery. It must reject conversational coordinator turns, specialists, cloud
fallback, publication, automatic follow-up execution, repository setup scripts,
connected-app tools and inherited private transcripts.

This remains a proposal, with these required foundations:

1. **Owner-bound pairing v2.** Mint pairing only from an authenticated verified
   human. Bind the versioned nonce to that human, deployment, intended scope and
   expiry; consume it atomically. Persist the owner on the machine and preserve
   it across heartbeat. Legacy unowned machines cannot become personal by
   inference or a client-supplied owner field. Filter list, readiness and revoke
   by owner. Personal machine tokens must never claim unrelated unpinned work.
2. **Explicit local account and billing mode.** The human selects the harness
   and effective account mode. Use a supported non-inference local auth probe to
   establish non-secret account metadata where the installed CLI permits it.
   Missing proof means unavailable. Pin the account fingerprint/version and
   recheck before execution. Do not silently inherit API keys, copy another
   provider's credential, adopt an org connection or switch billing lanes.
   Tokens remain on that machine and are never returned to the Worker or room.
3. **Versioned server-owned grant.** Bind a grant to the verified human, active
   workspace membership, machine, exact harness/account mode, allowed repository
   scope, allowed phases, expiry and revocation version. Occupational roles and
   room membership alone grant no machine, billing or provider authority. The
   operator must explicitly enable the supported hosting scope; the human must
   consent to using their selected account and sharing results with that room.
4. **Frozen execution proof.** Include the grant revision, owner, machine and
   account fingerprint, allowed phases, employee profile version, room context
   digest, selected sources and audience in the same human-approved input and
   signed local envelope. Recheck membership, source access, machine ownership,
   account and grant at approval, dispatch and claim. Revocation must prevent
   new claims and cancel queued work without retrying on a different machine.
5. **No implicit operator inference.** The grant must explicitly forbid or
   authorize every coordinator, specialist, TypeSafe, distillation, follow-up and
   review phase. Enforce this on normal and recovery/wake paths. Presence of a
   deployment key or model binding is configuration, not consent. Unsupported
   phases must fail closed before sending task data or starting model work.

The unresolved decision is whether this narrow direct local slice is desired,
and whether any operator-funded inference is permitted for invited members.
If permitted, the allowed phases, data destinations, funding authority, limits
and revocation rules must be explicit. No amount-aware spend or funding contract
is inferred from an invitation or the request to use a personal Claude/Codex
account.

## Required acceptance evidence

Use two verified members with different paired machines and a removed member.
Prove that one member cannot list, revoke, claim, control or receive another's
machine work, account metadata, task, transcript or artifacts. Reject legacy and
forged pairing, replayed nonce, changed grants/accounts, stale membership,
unreviewed employee changes and cross-workspace sources. Approval must bind the
exact local execution and an agent must never approve itself.

Prove missing/expired login, offline machine, revoked grant, cancellation,
restart and duplicate delivery produce no account, machine or cloud fallback.
Instrument the permitted direct lane to prove zero coordinator, specialist,
TypeSafe or distillation calls when those phases are forbidden. Verify actual
Claude/Codex account execution only in an authorized environment after these
boundaries pass. Existing local CLI fixtures and provider connection badges do
not establish that live personal-team capability.

This assessment used source inspection only. It made no credential attempt,
model call, account change, remote write or execution-policy change.
