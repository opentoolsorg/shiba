# Architecture as built

Measured snapshot refreshed on 2026-11-25 from the current branch. This document
is evidence, not the product target. Read `ARCHITECTURE.md` for the living
employee-platform architecture and `docs/product/ai-employees.md` for the product
contract. Where this file disagrees with older prose, this file is the measured
state at the date above.

## 1. Current shape

One Cloudflare Worker is the API, static host, control plane, integration host,
and execution coordinator. Durable Objects coordinate live state. D1 holds shared
domain records. R2 stores private artifact bytes. KV stores token lookups.
Vectorize stores embeddings. Queues and Workflows carry asynchronous work.

The current implementation still uses legacy orchestration names:

- `CodingOrchestrator` is the main orchestration Durable Object. Architecturally
  it acts as the Employee Orchestrator, but large parts of its execution contract
  still use coding-run terminology.
- `OpenCodeAgent` is the sandbox-side execution child. Architecturally it is a
  Run Execution Agent. It is not an OpenCode-only product boundary.

The system already supports more than repository runs. The measured execution
input supports repository targets, artifact-workspace targets, and a future
connected-app target schema. Connected-app execution is still constrained by
adapter and permission readiness. Employee app-tool turns can run worker-side
without a repository sandbox when the selected employee and grants allow them.

## 2. Measured numbers

Command used for the source counts:

```sh
python3 - <<'PY'
import os
files=[]
for dp,_,fs in os.walk('apps/backend/src'):
  for f in fs:
    if f.endswith(('.ts','.tsx')):
      p=os.path.join(dp,f)
      files.append((sum(1 for _ in open(p,errors='ignore')),p))
print(len(files), sum(x for x,_ in files))
print(sorted(files, reverse=True)[:12])
PY
```

| Measure | Current value |
|---|---:|
| Backend TypeScript/TSX files | 699 |
| Backend source lines | 112,313 |
| Backend test files | 581 |
| D1 SQL migrations | 76 |
| Durable Object bindings | 16 |
| Largest backend file | `apps/backend/src/agents/orchestrator.ts`, 8,057 lines |
| Other large files | `runtime.ts` 1,741 · `collaboration-routes.ts` 1,669 · `collaboration-store.ts` 1,641 · `memory-do.ts` 1,469 · `mailbox-store.ts` 1,449 |
| Deploy paths | `alchemy.run.ts` primary, `apps/backend/wrangler.jsonc` rollback |

These numbers supersede the older 21k-line/eight-Durable-Object snapshot.

## 3. Durable Objects currently bound

From `apps/backend/wrangler.jsonc`:

| Binding | Class |
|---|---|
| `CodingOrchestrator` | `CodingOrchestrator` |
| `OpenCodeAgent` | `OpenCodeAgent` |
| `Sandbox` | `Sandbox` |
| `Automations` | `Automations` |
| `Mailbox` | `Mailbox` |
| `Memory` | `Memory` |
| `Waitlist` | `Waitlist` |
| `ModelConfig` | `ModelConfig` |
| `LocalDispatch` | `LocalDispatch` |
| `ChatGptAuth` | `ChatGptAuth` |
| `UserProviderOAuth` | `UserProviderOAuth` |
| `Spaces` | `Spaces` |
| `ConversationRoom` | `ConversationRoom` |
| `WorkspaceEvents` | `WorkspaceEvents` |
| `DISCORD_GATEWAY` | `DiscordGateway` |
| `BrowserSession` | `BrowserSession` |

`wrangler.jsonc` also declares Slack import/media workflows and an automation-run
workflow. Those are workflow bindings, not Durable Object namespaces.

## 4. Execution targets currently represented

`packages/shared/src/execution-target.ts` defines three target kinds:

| Target kind | Status |
|---|---|
| `repository` | Production execution path. Carries `repoUrl` and `baseBranch`. |
| `artifact-workspace` | Implemented no-repository output path. Requires expected deliverables or an ephemeral workspace identity. Ephemeral workspace outputs must stay under `out/`. |
| `connected-app` | Schema exists for future work. It describes a requested action but does not grant permission or prove executability. Intake must reject it until a permissioned adapter and action approval exist. |

`workspaceTarget` is the user-facing selection. It freezes into
`executionTarget` before approval and dispatch.

## 5. End-to-end execution path as implemented

### Repository and artifact sandbox path

1. A dashboard, channel, automation, or API caller creates work.
2. The Employee Orchestrator implementation (`CodingOrchestrator`) resolves the
   selected employee/custom agent, composer pin, project context, attachments,
   environment, target, harness, model route, runtime, and organization scope.
3. `resolveRoute` freezes the harness/model route. `assertRunPreflight` rejects
   inadmissible combinations before the approval card.
4. The approval freezes the exact execution input. The sandbox does not start
   before approval.
5. Dispatch goes to the Run Execution Agent implementation (`OpenCodeAgent`).
6. `SandboxRuntimeAdapter` prepares either a repository checkout or an isolated
   artifact workspace.
7. Exactly one selected harness runs through the scoped executor.
8. The adapter captures checkpoints, progress signals, files, diffs, test
   evidence, deliverables, and errors.
9. Artifact workspace results can be privately archived. Expected deliverables
   are verified against the produced files.
10. Pull request publication uses its own approval/publication path when
    requested. Execution success alone is not publication authority.

### Local runtime path

`LocalRuntimeAdapter` uses `LocalDispatch` as a mailbox. The Worker does not
execute on the operator machine. A paired daemon claims approved work and posts
back the same result shape. Local artifact work has stricter rules: no
repository target, matching nonempty approved deliverables, no personal
repository grant, and no publication. Attachments and per-run environment
variables are not supported there yet.

### Employee app-tool path

A turn pinned to a custom employee can use worker-side app tools without a
repository sandbox. `beforeTurn` resolves the selected employee, actor,
workspace, profile/version, grants, selected skill versions, and onboarding
context. Search or catalog visibility never grants execution. Tool policy is
checked by the Worker. Skills are untrusted instructions and never grant tools
or approve actions.

This path can retain internal drafts from approved/read sources. It does not by
itself prove connected-app mutation execution is production-ready.

## 6. Harness state

The harness seam is real and broader than OpenCode. The image and registry carry
multiple CLI and ACP lanes. Harness selection is a runtime input, not the
architecture owner. The run execution envelope still uses coding terminology in
several types because the repository lane was built first.

Important harness facts:

- egress hosts are selected per harness, not as a union;
- error envelopes throw so errors cannot silently become success;
- scoped execution gates sandbox commands;
- subscription lanes use separate harnesses and explicit deployment flags;
- capabilities now matter because harnesses differ in runtime support,
  reasoning levels, verification, and local execution support.

## 7. Security state

The original core invariants still hold:

- no sandbox before approval;
- credentials never enter the container;
- repository credentials are scoped to the approved repository path;
- sandbox egress is policy-controlled;
- each ingress surface authenticates independently.

The employee platform adds current authority planes: workspace membership,
employee profile/version, exact tool grants, artifact provenance, browser and
computer session authority, integration receipts, and separate publication
approval. These are architectural requirements, not optional UI wording.

## 8. Current architectural risks

1. **`orchestrator.ts` is too large.** At 8,057 lines it owns conversation,
   employee policy, composer intake, approval, dispatch, recovery, artifacts,
   publication, channel behavior, and tooling. This is the primary
   maintainability risk.
2. **Implementation names lag product roles.** `CodingOrchestrator` and
   `OpenCodeAgent` are live bindings. Documentation can label the roles, but a
   real rename requires a migration plan.
3. **State ownership is split.** Docs that say Durable Objects hold all state
   are wrong. D1 owns many durable workspace/domain records.
4. **Connected-app execution is not proven by schema presence.** The schema is
   explicit that it does not grant permission or establish executability.
5. **Employee collaboration is not proven by employee profiles.** The current
   coordination contract remains review-only until its activation gates pass.
6. **Artifact and local lanes need independent verification.** Do not use a
   successful repository run as proof for every lane.

## 9. Reading order

1. `ARCHITECTURE.md` — living target and compatibility labels.
2. `docs/product/ai-employees.md` — product contract.
3. `docs/architecture/structure.md` — domain model and layers.
4. `docs/architecture/topology.md` — control and execution topology.
5. `docs/architecture/durable-objects.md` — state ownership.
6. `docs/architecture/request-lifecycle.md` — shared work lifecycle.
7. `docs/architecture/security-model.md` — authority invariants.
8. `docs/architecture/runtime.md` — infrastructure and runtime seams.
9. `docs/architecture/ui.md` — client target shape.
10. `docs/plans/plan.md` and `docs/verification/verification.md` — dated implementation evidence.
