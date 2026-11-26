# Security and authority model

Shiba is approval-first. The model below applies to coding and non-coding work.
A design that weakens one invariant is wrong even if a lane still passes its own
tests.

## Invariants

1. **No execution before required approval.** Queueing or planning may happen
   first. A sandbox, local job, app mutation, browser/computer action, or
   publication must not start before the exact approval required by its policy.
2. **Approval freezes scope.** The approved envelope pins the actor, workspace,
   employee profile/version, target, action, resources, runtime/model lane,
   expiry, and limits. The executor cannot widen it.
3. **Credentials never enter a sandbox or untrusted execution environment.** The
   Worker-side control plane or egress proxy attaches scoped credentials. The
   execution environment sees placeholders or narrowly scoped capabilities.
4. **Authority is least privilege by default.** Repository access is scoped to
   the approved repository/ref/action. Integration access is scoped to the exact
   connection/action/resource. Browser/computer access is scoped to the approved
   session/profile or dedicated machine.
5. **Membership is not execution authority.** Workspace membership, employee
   access, connected apps, templates, memory, and browser sign-in state are
   separate grants. Presence of a resource never implies permission to use it.
6. **Child work cannot exceed parent authority.** Delegated or employee-to-
   employee work must carry a bounded subset of the parent scope and remain
   reviewable in the same lineage.
7. **Private context stays private unless explicitly shared.** Recall and context
   selection must carry source, workspace, employee, and revocation policy. A
   response must not leak private memory into a shared surface.
8. **Publication is separate from execution.** Sending, posting, merging,
   purchasing, inviting, deleting, or otherwise changing an external system needs
   its own approval and receipt.
9. **Every external effect is auditable.** Receipts, idempotency keys, provider
   responses, artifact hashes/paths, actor, approval, and run lineage must make
   the effect reconstructable.
10. **Unknown remains unknown.** If the system cannot prove completion or
    non-completion, it records outcome unknown. Retries require a receipt anchor
    or reconciliation path.
11. **Every surface authenticates.** Dashboard, channel ingress, MCP, webhooks,
    local daemon, browser/computer control, and internal service calls use their
    own authentication and authorization boundary.
12. **Egress is policy-controlled.** Sandbox egress starts deny-by-default and
    opens only for approved destinations. Other lanes use explicit provider or
    connector credentials and audited action paths.

## Authority planes

| Plane | Examples | Rule |
|---|---|---|
| Workspace membership | Owner, admin, member, viewer, invitations | Controls who can see and manage workspace resources. It does not execute work. |
| Employee configuration | Instructions, skills, model/runtime, version, readiness | Controls what an employee is configured to do. Hiring does not start work. |
| Resource grant | Integration connection, repo, artifact folder, browser profile, computer, local machine | Controls what may be selected. It is not blanket execution consent. |
| Task approval | Exact work/action/input/target | Controls what may run now. |
| Publication approval | Send, post, merge, publish, purchase, invite, delete | Controls external effects after review. |
| Observation/evidence | Read-only connector reads, screenshots, logs, receipts | Provides proof. It must not become hidden mutation authority. |

## Sandbox lane guarantees

- The sandbox starts only after approval.
- GitHub egress is refused until the approved repository scope exists.
- Tokens are scoped to the approved repository and never become general GitHub
  credentials inside the container.
- Model and subscription tokens are attached outside the container.
- Output archives are private. Owner-only access is minted when requested.
- Harness CLIs are execution tools inside the lane. They do not define workspace
  authority.

## Employee platform additions

AI employees broaden the security model beyond the coding sandbox:

- employee profile/version must be pinned in the run envelope;
- tool policy must resolve before an integration action;
- app actions need receipts and idempotency behavior;
- artifact workspaces need private storage and provenance;
- browser profiles and shared computers need explicit grants and release;
- local machine execution must remain tied to the paired user/machine lane;
- employee-to-employee execution remains disabled until the coordination gates
  in `docs/team-employee-coordination.md` pass.

## Practical test

Before shipping a lane or integration, answer these questions in code or docs:

1. What exact approval starts it?
2. What authority does the approval freeze?
3. Where do credentials live, and where do they never appear?
4. What evidence proves the result?
5. How is cancellation propagated?
6. How are retries idempotent?
7. What external effect needs separate publication approval?
8. What is explicitly not enabled yet?

If an answer is missing, the feature is partial. Say that in the UI and docs
instead of treating a successful narrow path as production readiness.
