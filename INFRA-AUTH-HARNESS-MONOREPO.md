# Infra, auth, harness, and monorepo architecture

Refreshed 2026-11-25 from the current branch. This document explains how the
backend actually carries work end to end. It supersedes the September coding-
spine assessment. Read `ARCHITECTURE-AS-BUILT.md` for measured counts and
`ARCHITECTURE.md` for the employee-platform target.

## 1. End-to-end runtime path

```text
dashboard / channel / automation / API / MCP
  → surface-specific authentication
  → workspace and employee context resolution
  → composer pin or structured task intake
  → route preflight: employee, target, harness, model, runtime, resources
  → exact approval record
  → approved dispatch through the run/event spine
  → execution lane
  → progress/events/artifacts/receipts
  → verification or explicit unverified/unknown state
  → human review
  → separate publication approval when an external effect is requested
```

The implementation labels are still legacy:

- `CodingOrchestrator` is the live Employee Orchestrator implementation.
- `OpenCodeAgent` is the live Run Execution Agent implementation for sandbox
  execution.
- Harness names describe execution CLIs or transports. They do not own product
  orchestration.

## 2. Intake and authority

Intake has three important boundaries.

1. **Human composer pins outrank model prose.** The latest user message can pin
   target, employee/custom agent, project context, skills, attachments, task,
   model route, and environment metadata. The model cannot widen those fields
   through a tool call.
2. **Targets freeze before approval.** `workspaceTarget` is a user-facing
   selection. It normalizes into `executionTarget` before dispatch. Current
   target kinds are `repository`, `artifact-workspace`, and `connected-app`.
3. **Route preflight happens before a container or lane starts.** Harness,
   model, connection, runtime, organization scope, publication request, personal
   execution snapshot, and target are validated before approval is executable.

`connected-app` is currently a schema boundary, not proof of production
execution. It describes a requested action. It does not grant permission or make
the action executable.

## 3. Repository and artifact sandbox flow

The sandbox lane is the most complete execution lane:

1. `CodingOrchestrator` approves and dispatches a structured run.
2. `OpenCodeAgent` receives the structured envelope.
3. `SandboxRuntimeAdapter` prepares an ephemeral container.
4. Repository targets clone the approved repository/ref. Artifact workspace
   targets initialize an isolated git-backed workspace without a repository.
5. The scoped executor constrains commands. Exactly one harness lane runs.
6. The adapter captures hidden git checkpoints, progress signals, files, diffs,
   test evidence, and errors.
7. Artifact workspace output is exported privately. Expected deliverables are
   checked against produced files.
8. A pull request or other external publication requires the relevant
   publication path. A completed run is not publication authority.

Artifact workspace rules are explicit:

- ephemeral workspace deliverables must be inside `out/`;
- workspace templates require an ephemeral workspace identity;
- expected deliverables are required unless an ephemeral workspace identity is
  present;
- publication and repository grants are not implied.

## 4. Local runtime flow

`LocalRuntimeAdapter` does not execute work in the Worker. It uses the
`LocalDispatch` mailbox:

```text
approved envelope → LocalDispatch mailbox → paired operator daemon
  → local harness execution → posted result shape → normal run evidence path
```

The local lane is intentionally narrower today:

- no cloud desktop;
- no per-run environment variables yet;
- no attachments yet;
- no repository setup path yet;
- local artifact work requires a no-repository target, matching nonempty
  approved deliverables, no personal repository grant, and no publication;
- the harness must advertise `local` in its supported runtimes.

The security boundary is the pairing token plus the approved mailbox job. A
daemon claim is not authority to invent new work.

## 5. Employee app-tool flow

Not every employee action uses the sandbox lane. A turn pinned to a custom
employee can use worker-side app tools. `beforeTurn` in the orchestrator:

- resolves the selected employee and employee version;
- resolves actor and workspace scope;
- checks current grants and policy;
- resolves selected reviewed skill versions;
- enables only the tools allowed for that context;
- treats skills as untrusted instructions, never grants;
- keeps catalog search separate from execution permission.

This path can support read/research/draft-retention behavior without a
repository. It does not prove that connected-app mutations are production-ready.
Mutations still need action-specific approval, adapter support, receipts, and
idempotency behavior.

## 6. Harness architecture

The harness seam is the execution transport inside a lane, not the product
center.

Important properties:

- one run selects exactly one harness;
- egress hosts are composed for the selected harness, never as a union of all
  harnesses;
- parser error envelopes throw, so provider errors cannot become successful
  progress text;
- subscription harnesses are separate explicit lanes and are dark without their
  deployment flags;
- capability data must drive runtime support, reasoning levels, verification
  support, and UI availability;
- Dockerfile pins and harness catalog versions must remain synchronized.

The old statement “OpenCode is the coding harness” is no longer architecturally
sufficient. OpenCode is one harness lane. `OpenCodeAgent` is the legacy name of
the sandbox execution child that can coordinate multiple harness lanes.

## 7. Model and credential routing

Model routing is frozen before approval. Depending on the lane, the route can
come from a role pin, an employee/custom agent default, a user connection, an
explicit run selection, or deployment defaults.

Credential rules remain load-bearing:

- real provider and subscription credentials never enter the sandbox;
- the sandbox sees placeholders or dummy keys;
- the egress proxy or Worker-side control plane attaches credentials;
- repository credentials are scoped to the approved repository path;
- named subscription accounts are secret names, never credential material in
  task input;
- a stored secret or successful callback is not proof that a provider works.
  Capability probing and run evidence are required.

## 8. Auth surfaces

Every ingress surface authenticates independently:

- dashboard/session auth;
- Cloudflare Access where configured;
- Slack, Discord, Telegram, GitHub, email, and webhook signature or secret
  checks;
- MCP bearer/OAuth behavior;
- local daemon bearer/pairing;
- internal Worker-to-Durable-Object signing.

Do not inherit trust across surfaces. A valid Slack message is not dashboard
authority. A valid MCP token is not local-daemon authority. A paired machine is
not a workspace admin.

## 9. Monorepo ownership

| Area | Owner |
|---|---|
| API, Durable Objects, runtimes, integrations, execution control | `apps/backend` |
| Dashboard client | `apps/frontend` |
| Public docs/marketing | `apps/web` |
| Shared wire contracts | `packages/shared` |
| Local daemon | `apps/local-daemon` and related scripts |
| Deployment | `alchemy.run.ts`, `apps/backend/wrangler*.jsonc` |

Boundary types that cross Worker, dashboard, sandbox, MCP, or daemon belong in
`packages/shared`. Keep that package free of Worker bindings, provider clients,
DOM dependencies, and credentials.

## 10. Current structural risks

1. `apps/backend/src/agents/orchestrator.ts` is 8,057 lines. It owns too much:
   conversation, employee policy, intake, approval, dispatch, recovery,
   artifacts, publication, and channel behavior.
2. Legacy names still shape the execution contract. `delegate_coding_task`,
   `CodingOrchestrator`, and `OpenCodeAgent` make non-coding work look like a
   special case even when the implementation has outgrown that model.
3. Documentation must not claim that connected-app execution or employee-to-
   employee execution is production-ready before the adapters, approval, and
   receipt gates exist.
4. Runtime and harness capabilities must remain explicit. A harness that works
   in a sandbox does not automatically work locally or for artifact output.
5. Deployment drift between `alchemy.run.ts` and `wrangler.jsonc` remains a
   release risk. Bindings, secrets, vars, migrations, queues, workflows, and
   container settings need parity checks.

## 11. What to improve first

1. Split orchestrator responsibilities into owned modules before adding more
   employee-platform behavior.
2. Introduce product-role terminology in new contracts while preserving current
   binding compatibility.
3. Add a general execution-envelope name beside the legacy coding input types.
   Do not break shipped wire contracts.
4. Make connected-app action execution pass the same approval, receipt,
   cancellation, idempotency, and evidence gates as repository execution.
5. Keep artifact, local, browser, computer, and app-tool lanes independently
   verified. Do not use one lane's success as proof of another.
6. Add automated deploy-parity checks for bindings, secrets, vars, workflow and
   queue declarations, migrations, and container settings.
