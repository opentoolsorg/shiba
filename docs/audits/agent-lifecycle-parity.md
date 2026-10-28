# Agent lifecycle comparison and acceptance

Inspected on 2026-10-28. Reference: `LayerNorm/overlay-web` commit
`49146167572130e171db8d566edc0bf2f176aa73`. This focused review responds to the
request for agents working end to end, beyond storing a bot definition or
opening an empty conversation. It records source contracts and missing
acceptance; subsequent implementation results belong in the final audit report.
No Overlay application or real provider execution was performed by this review.

## Implemented lifecycle and executed acceptance

The comparison below records the starting gaps. This follow-up closes the
following relevant lifecycle paths in Shiba's existing architecture:

- The agent form exposes model and ready model-connection choices and preserves
  other configuration when editing. Clearing an optional setting clears the
  stored value. A version conflict preserves the draft until an explicit reload.
- Profile edits and version history commit atomically through D1 batch and a
  conditional version update. Real SQLite tests and real local Worker/D1 requests
  verify one winner and one 409 for concurrent edits, plus rollback on history
  failure.
- Agent archive and restore are distinct from deletion. Active/archived
  directories preserve the same profile identity, version history and existing
  conversations. Archived profiles cannot start new threads or executions.
- Trusted profile identity, revision, sandbox provider and org now survive run
  creation, approval, execution and terminal persistence. The approval hash binds
  the revision. Editing v2 into v3 never substitutes v3 instructions or model into
  the approved v2 run. The UI shows the retained profile revision.
- Unsupported per-profile tool grants are rejected at configuration and
  execution boundaries, including legacy stored grants. Mandatory approvals and
  deployment tool/egress restrictions remain in force.

Final verification on the changed branch:

| Check | Actual outcome |
| --- | --- |
| Complete workspace unit/integration suite | **3,148 passed, 3 skipped**; 8 workspace tasks completed. Backend 2,714; frontend 180. |
| Root typecheck, build, CI lint/Knip, import lint, stack drift and built-output test | PASS; existing lint warnings remain. |
| Combined packaged-Worker browser gate | **31 checks passed**: 11 mock coding/review, 9 local bot/thread, 11 Bot lifecycle checks. The affected 11 were refreshed after the final session fix. |
| Bot lifecycle browser and Electron path | Real Bot forms → named thread → composer submit → visible failure/draft recovery → same-command-ID retry → frozen v2 approval → Approve click → synthetic executor → stored v2 result and scoped panels → archive/restore/history. Eleven checks pass on each target. |
| Cross-version execution regression | Controlled harness receives original instructions/model/version after a newer profile is saved; archive/delete before approval refuses execution. |
| Lifecycle target guard | Driver requires declared mock/disabled-container/stand-in modes and the recorded local Worker port before any fixture writes or approval. |

The lifecycle browser driver is
`.cursor/skills/verify-shiba/scripts/drive-agent-lifecycle.mjs`. CI enables it with
`VERIFY_AGENT_LIFECYCLE=1` in the existing local mock harness, retains traces and
screenshots under `.verify/agent-lifecycle/`, and preserves failure evidence
before cleanup. The final combined evidence bundle is
`.verify/evidence/ci-local-20261028T062356Z/`; the affected final lifecycle was
refreshed under `.verify/{agent-lifecycle,desktop-agent-lifecycle}/`. It creates
and cleans up only its own returned fixture IDs. Final test output is
`/tmp/shiba-bots-final-tests.log`
and the runtime report links the browser evidence.

This establishes the implemented local lifecycle with a **synthetic execution
boundary**. Selected Bots now queue through the actual composer without a
separate planner call, and approval is clicked in the real UI. The separate
local-daemon journey also passes actual file edits/diffs and cancellation in
web and Electron with a fixture model CLI; see [Bot acceptance](bots-e2e.md).
No live model inference,
real sandbox/provider run, real PR mutation, unrelated-tenant runtime isolation,
or full Overlay feature equality is claimed. Creator/workspace sharing roles,
granular tool grants, and canonical public multi-run conversations remain
separate requirements.

## Which reference agent functionality is relevant

Overlay's enabled native agent is a workspace-owned identity with instructions,
a model, tool grants and visibility. A user opens a persistent conversation with
that identity; runs are executions inside the conversation. Its native turn
pipeline resolves the agent grant, prepares allowed tooling and persists run
state/messages through the workflow. The relevant source is:

- `src/features/agents/components/NewAgentDialog.tsx` and
  `use-agent-editor-actions.ts`: creation, save, error recovery and opening the
  saved identity.
- `src/server/agents/WorkspaceAgentService.ts`: workspace membership, creation
  policy, runtime/config validation, visibility and editor/archive permissions.
- `src/server/agents/agent-tooling.ts` and `workspace-agent-durable.ts`:
  server-owned tool grants carried into the native turn pipeline.
- `convex/agents/agentThreads.ts`: separately persisted user/agent conversations.

`src/shared/config/defaultOverlayRuntimeConfig.ts` leaves `externalAgents`,
`connectedAgentControlPlane`, `remoteAgentRuns`, `overlayCloudEnvironments`,
connected artifacts/drive and legacy managed harness agents **disabled by
default**. Their presence is not evidence of working hosted Codex/Claude agents.
Native computer support also requires a configured provider; its enabled flag
does not establish a provisioned machine.

## Lifecycle contracts

| Step | Overlay native-agent source contract | Shiba implementation at inspection | Required parity or acceptance |
| --- | --- | --- | --- |
| Create identity | Name/instructions/model required; runtime/model validation; workspace creation policy; optional avatar and visibility. | `CustomAgentsView.tsx` → `/api/custom-agents` → Effect schema/harness validation → org-scoped D1 profile. Instructions, harness, optional model/connection/provider/repository are stored. | Keep one clear path from form to saved identity and meaningful validation errors. Saving a profile is not a successful run. Per-profile readiness should explain unusable model/connection/provider settings before a task vanishes into setup failure. |
| Edit safely | Editor policy checked server-side; changed effective harness/model configuration is revalidated. | `expectedVersion` is accepted, but `custom-agents-store.ts:updateCustomAgent` checks a read value and then updates without a version predicate; configuration and version-history writes are separate. | Use a real atomic compare-and-swap and consistent version history. A simultaneous edit must return a conflict without overwriting the winner; test with actual SQL/storage behavior, not only a sequential fake. |
| Select tools | `allowedToolIds` narrows server tooling after deployment/account policy; a grant cannot widen withheld capabilities. | `CustomAgentConfig.toolScopes` is accepted and documented, but `overridesFromCustomAgent` does not return it and the selected profile does not enforce it in the harness/MCP tool surface. | Do not offer or claim profile-specific permission controls while ignored. Reject unsupported grants explicitly or implement a tested narrowing policy; never replace approvals/egress with a broad tool preset. |
| Scope identity | Creator/workspace visibility, workspace membership, creator/manager edit/archive policy. | Profiles are org-scoped; dashboard profiles are deployment/account-owned. Named sessions have separate per-user ownership. | Preserve org checks and validate bot/session association server-side. Creator-only sharing/team roles need an explicit membership/ownership design; they cannot be inferred from a single org ID. |
| Open conversation | Agent definition and user/agent conversation have separate IDs; main-thread resolution and multiple conversations are explicit. | New Start thread creates a named per-user session with `metadata.customAgentId`; cards list associated sessions. Thread rename and restoration use existing session APIs. | Validate persisted association and current profile availability; keep independent threads. Define main-thread and archive semantics only if implementing them. Run IDs in `/api/v1/threads` remain a compatibility projection, not the same conversation registry. |
| Freeze effective task | Native invocation resolves saved agent configuration and server tooling before execution. | Structured composer metadata pins the selected ID; orchestrator intake resolves instructions/harness/model/connection/provider and mints a pending approval. Deleted/missing profiles now fail rather than silently running a generic agent. | Assert the exact effective task/config in a configured-bot execution journey. `customAgentVersion` is computed by the resolver but was not carried into approval/run provenance at inspection; preserve revision evidence if configuration history is advertised. |
| Execute and observe | Native workflow/gateway persists messages, tool activity and terminal run state. | Shiba's approved run dispatches its selected harness through sandbox adapters/egress, with signals, diffs and terminal status. The generic mock core loop passes, while the original bot browser journey stops before execution. | Combine profile creation/configuration, conversation, task intake, pending approval, approved executor, persisted result and reload into one executable journey. Clearly label synthetic executor/mock GitHub boundaries. A real provider/harness run needs its own configured acceptance. |
| Cancel and recover | Durable run/cancellation state and workflow recovery are separate from the directory UI. | New regressions cover descendant cancellation, terminal-parent spawn denial and queued-owner inheritance; run recovery/receipt logic exists. | Check cancel while running, stale callbacks, retries and restart recovery for an actual configured bot. A terminal parent must not leave active grandchildren or permit fresh delegation. |
| Archive and restore | Agents are archived first; history remains readable; archived agents reject new work; authorized restoration is explicit; permanent deletion is separate. The default master agent is protected. | DELETE soft-deletes a profile and hides it. No archived directory/restore API or UI was found in the inspected profile CRUD. Existing named-session history is a separate resource. | Add explicit archive/list/restore behavior if this management parity is in scope. Keep conversation history readable and deny execution while archived. Do not present irreversible deletion or session teardown as an archive operation. |
| Reopen and manage history | Per-agent conversation list, archived conversations and separately identified automated work. | Bot-associated session cards and named-session history/default restoration are implemented during this task; full canonical transcripts, compaction and conversation archive/restore remain distinct gaps. | Test messages as well as empty session metadata after refresh and A→B→A navigation. Per-bot listing must use validated association and honest loading/error states. |

The comparison describes code presence and specific identified gaps. It does not
mark a reference flow WORKING merely because its service or UI exists.

## Smallest cohesive end-to-end acceptance

One useful complete slice for Shiba is:

1. Create a bot with instructions and a supported model/harness/provider; edit
   it and exercise a stale-version conflict.
2. Start an associated named conversation through the bot card, then reopen it
   from that bot's conversation list. A different user/org cannot target it.
3. Submit a task with the bot ID carried in structured metadata. Read back the
   pending approval and verify its effective instructions, repository,
   model/connection/provider and profile provenance. No executor has started.
4. Reject once and prove no executor/container was created. Submit again,
   approve the frozen input and observe one run. Repeated approval must not
   dispatch another executor.
5. Collect a result/diff, persist terminal status and reload the conversation.
   Test provider/queue failure and cancellation, including descendants.
6. Archive the bot, retain history, reject new work, restore it and open a new
   conversation. Keep permanent deletion separate and explicit.

The first combined journey can use the repository's synthetic executor/mock
GitHub boundary to validate application wiring without external side effects.
That proves only the stated local contracts. A **live end-to-end agent** claim
additionally needs one supported configured provider and sandbox to clone the
approved repository, perform the model/tool loop and produce a verified diff.
Publishing a PR, posting a review or sending a message remains a separate
authorized action.

## Priorities

**P0:** preserve human approval and credentials outside the sandbox; enforce
profile/session and caller ownership; fail closed on unavailable profiles and
unsupported permission claims; fix lost-update/version-history races before
advertising safe concurrent profile management.

**P1:** finish the configured-bot execution journey and revision provenance,
per-profile readiness/errors, archive/restore management, persisted-message
reload and repeat/cancel/recovery proof. Fold these into the combined CI and
browser gate with exact read-backs and cleanup of only invocation-owned fixture
IDs.

**P2:** add creator/workspace visibility, team management, richer tool grants,
main-thread policies or dedicated computers only with explicit authorization,
storage/cost and lifecycle contracts. Preserve Shiba's existing Worker/DO/D1
architecture and identity instead of copying Overlay's vendor stack or dormant
external-agent control plane.
