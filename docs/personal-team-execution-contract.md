# Personal execution for invited team members

Status: a narrow personal local execution contract is implemented behind the
default-off `SHIBA_PERSONAL_LOCAL_EXECUTION=1` and `SHIBA_LOCAL_RUNTIME=1` flags.
Both the pairing and internal signing keys must have at least 32 characters;
missing prerequisites keep setup unavailable. Integrated acceptance remains
required before enabling it. This extends the
team employee request; it is not a prerequisite from the original four-phase
control plane plan. This document does not enable execution or certify a live
Claude or Codex account.

## Current boundaries

- [`team-member-auth.ts`](../apps/backend/src/team-member-auth.ts) keeps deployment
  provider setup and the operator computer fleet separate from invited accounts.
  The new personal namespace authenticates a verified native account and exact
  workspace membership itself; it grants no deployment administration rights.
- [`model-connections.ts`](../apps/backend/src/model-connections.ts) defines
  connections as `owner: "deployment"`. A missing connection selection can adopt
  the sole ready connection or implicit deployment default in
  [`model-policy.ts`](../apps/backend/src/model-policy.ts). A personal route must
  not inherit either behavior.
- Legacy pairing signs a nonce and expiry and retains the existing operator
  fleet. Personal pairing v2 additionally binds the verified account UUID,
  canonical actor, exact workspace membership version and role, origin and
  single-use expiry. Personal machines are excluded from the operator fleet and
  cannot claim its pinned or unpinned work. The operator bearer and another
  member's machine cannot claim or inspect personal jobs.
- The legacy path in [`shiba-local-daemon.mjs`](../scripts/shiba-local-daemon.mjs) inherits the
  selected provider's local API key when present and
  [`link-operator-auth.mjs`](../scripts/link-operator-auth.mjs) copies both Claude
  and Codex login files into a disposable run home. CLI presence in a heartbeat
  proves neither the account nor the effective API-key/subscription billing
  lane. These are existing single-operator paths, not a personal team grant.
  The personal lane separately requires an explicitly selected native account,
  selected-only credential staging and a fresh local CLI observation. See
  [personal local daemon](personal-local-daemon.md) for the supported evidence
  and failure behavior.

## Implemented personal contract

[`personal-execution-routes.ts`](../apps/backend/src/personal-execution-routes.ts)
exposes own computers, explicit pairing, grant creation and revocation, exact
CLI permission decisions, and Stop. A grant pins the owner, workspace,
membership version, machine revision, native subscription account fingerprint,
auth revision, harness, explicit coding model, anonymous public GitHub repository
and expiry. A machine or CLI account observation change increases the
server-owned revision; repeating identical fresh evidence does not.

[`personal-execution-store.ts`](../apps/backend/src/personal-execution-store.ts)
checks the immutable native account UUID and verified email against the exact
current membership in SQL. The public repository check sends no GitHub token or
cookies and rejects redirects or private repositories. The only allowed phase
is `local_repository_task`. A grant grants no app, private repository, workspace
credential, coordinator or specialist authority.

[`local-dispatch.ts`](../apps/backend/src/local-dispatch.ts) requires the exact
personal machine and account, current grant, retained human approval and run
generation before a one-shot claim. The proof binds the reviewed task, branch,
employee profile version, selected skill revisions and deliverable scope.
Personal envelopes cannot adopt executable arguments, provider environment
variables, setup commands, custom executable paths, resume sessions or reasoning
effort defaults. Cancellation does not permit redispatch under the same mailbox
run ID.
Personal daemon POST bodies have aggregate transfer limits: 16 KiB for control,
receipts and permissions, 1 MiB for events, and 8 MiB for results. Oversize bodies
return 413 before mailbox parsing; they are never silently truncated or
reexecuted. This is a narrower output transfer contract than the legacy operator
lane's individual file limits.

Each CLI permission binds a full source action hash, complete bounded review,
permission ID, original deadline, grant and machine revisions. Only the verified
native machine owner with the current personal grant may make the first
decision. This grants no authority over another owner's work or the shared
approval queue. The daemon can consume that decision once. Missing,
expired, incomplete, sensitive or changed requests fail closed. There is no
approve-all or agent approval path. A current member sees only minimal owned
Stop metadata after execution authority changes; revoked context is withheld.

Stopping or unpairing an already owned machine uses the immutable native owner
proof and does not require a still active execution grant or workspace
membership. That exception cannot read room content, approve a permission or
start work. Local account receipts are observations by the paired machine, not
provider-signed entitlement proofs. Native execution under the same OS user is
not an OS sandbox; a fresh HOME does not protect unrelated host files.

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

## Allowed execution slice

An explicitly submitted shared-room public repository task may run on the requesting
human's own paired Claude or Codex machine. The initial slice should allow only
direct submission, human approval, local execution and source-authorized result
delivery. It must reject conversational coordinator turns, specialists, cloud
fallback, publication, automatic follow-up execution, repository setup scripts,
connected-app tools and inherited private transcripts.

The required contract is:

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
   approval-bound local envelope. The mailbox checks the exact retained approval
   host through a signed internal RPC. Recheck membership, source access, machine ownership,
   account and grant at approval, dispatch and claim. Revocation must prevent
   new claims and cancel queued work without retrying on a different machine.
5. **No implicit operator inference.** The grant must explicitly forbid or
   authorize every coordinator, specialist, TypeSafe, distillation, follow-up and
   review phase. Enforce this on normal and recovery/wake paths. Presence of a
   deployment key or model binding is configuration, not consent. Unsupported
   phases must fail closed before sending task data or starting model work.

The narrow direct local slice is authorized for implementation. Operator-funded
inference remains outside this grant. Any future addition needs explicit allowed
phases, data destinations, funding authority, limits and revocation rules. No
amount-aware spend or funding contract is inferred from an invitation or the
request to use a personal Claude/Codex account.

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

The backend component evidence uses signed native sessions, real SQLite
membership and grant queries, and local mailbox fixtures. Anonymous GitHub reads
and the parent approval RPC are fixture responses in that component suite. The
separate parent, daemon and browser suites must establish their own boundaries.
These checks make no live credential attempt, model call, account change or
remote write. Live provider execution and deployed acceptance remain separate.
