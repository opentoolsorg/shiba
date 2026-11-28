# Employee work lifecycle

This is the shared lifecycle for work in Shiba. Repository sandbox execution is
one lane. Artifact generation, employee app actions, local-machine execution,
browser/computer sessions, automations, research, marketing, operations, and
channel-delivered work follow the same control shape.

```text
 1  intake      person/channel/automation creates or selects workspace work
 2  orient      employee runtime/orchestrator loads workspace, employee, and context
 3  plan        produce or update a goal/plan/task with exact scope
 4  approve     required human approver grants exact frozen authority
 5  dispatch    run orchestration mints or resumes an approved run/attempt
 6  execute     one execution lane performs the approved work
 7  evidence    lane emits progress, artifacts, receipts, errors, and provenance
 8  verify      lane and control plane record verification or explicit gaps
 9  review      workspace members inspect deliverables and decide next action
10  publish     a separate approved action may cause an external effect
11  follow-up   result becomes memory/context only under sharing policy
```

## Control requirements

- **Intent is structured before execution.** Prose can start a conversation, but
  a run starts from a structured task/action envelope.
- **Approval freezes authority.** The envelope carries actor, workspace, employee
  profile/version, target, action, resources, model/runtime lane, expiry, and
  limits.
- **The employee runtime/orchestrator does not perform external work.** It
  coordinates identity, conversation, approvals, lineage, and recovery. An
  execution lane performs the approved action.
- **Every run has lineage.** Parent/child work, retries, cancellation, receipts,
  and deliverables stay connected.
- **Evidence is part of the result.** A result without enough evidence is partial,
  blocked, failed, or unknown. It is not verified.
- **Publication is separate.** Creating a draft, branch, file, report, or plan
  does not grant permission to publish, send, merge, post, purchase, or mutate an
  external system.

## Lane differences

| Lane | Starts after approval with | Must return |
|---|---|---|
| Repository sandbox | Repo/ref/task, scoped git authority, harness/runtime selection | Diff or clear failure, logs, files, verification, optional PR publication evidence |
| Artifact workspace | Workspace folder/output contract, input files/context, employee profile/version | Files, versions, provenance, validation outcome |
| Employee app/tool action | Exact integration/action/input, workspace/employee grant, policy decision | Receipt, provider result or failure, idempotency key, external-effect status |
| Local paired machine | Machine/user lane, exact job envelope, daemon capability | Machine-local outcome, encrypted/archive evidence where applicable, completion status |
| Browser/computer | Session/profile or dedicated computer grant, takeover/control state, exact task | Action transcript/evidence, screenshots or logs where applicable, released session state |
| Research/operations/text lane | Goal/task, selected context, output contract | Reviewable deliverable, sources/provenance, verification or caveats |

## Repository sandbox detail

```text
 1  approve     exact repo/ref/task and harness/runtime route are frozen
 2  dispatch    room/coding orchestrator sends a structured envelope to the
                Run Execution Agent (current implementation: OpenCodeAgent)
 3  sandbox     Sandbox DO starts an ephemeral container for the run
 4  clone       container receives only the approved scoped git capability
 5  execute     exactly one harness CLI/ACP lane runs
 6  collect     worker/control plane collects diff, logs, output files, and status
 7  verify      tests/checks or explicit unverified state are recorded
 8  publish     push/PR/publication occurs only through its approved path
```

The Run Execution Agent coordinates this lane. It does not make independent
product decisions, and harness selection does not make that harness the system
orchestrator.

## Cancellation, retry, and unknown outcomes

Cancellation is an authority transition, not a best-effort UI action. The control
plane must stop new claims, revoke lane access where possible, propagate stop to
the lane, and preserve evidence for work already performed.

Retries create visible attempts in the same run lineage. They do not silently
replace the original attempt. If the control plane cannot prove whether an
external effect happened, the result is **outcome unknown**. A receipt or later
reconciliation must anchor any retry.
