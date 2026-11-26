# UI architecture: employee workspace target shape

This document describes the client architecture for Shiba as an AI employee
workspace. It replaces the older run-only dashboard framing. Repository runs are
one work surface. The UI must also make workspaces, employees, goals, approvals,
artifacts, integrations, local machines, browser sessions, and deliverables
legible.

## 1. Product objects the UI must make clear

The primary objects are:

```text
Workspace → people and employees → goals/plans/tasks → approvals → runs/attempts
  → deliverables/verification → publication/receipts
```

A user must be able to answer these questions without reading logs:

1. Who asked for this work?
2. Which employee and employee version is doing it?
3. What exactly was approved?
4. Which execution lane is running?
5. What resources, tools, machines, or integrations can it use?
6. What has it produced?
7. What is verified, unverified, blocked, failed, or unknown?
8. What external publication still needs approval?

## 2. Structural problems to avoid

- **Do not make the coding run the home of the product.** Runs belong under
  goals, tasks, employees, and workspace activity.
- **Do not hide approval inside a modal.** Approval is a first-class object with
  frozen scope, evidence, expiry, and consequences.
- **Do not let every component fetch the same fact.** Workspace, employee,
  approval, run, deliverable, and integration state each need one client owner.
- **Do not use navigation state as the only state.** Important work needs a
  shareable URL and must survive refresh.
- **Do not show connected as permitted.** A connected app, browser profile,
  computer, or machine is a resource. Permission comes from grants and approval.

## 3. Target client layers

```text
routes/             file-based routes, one file per workspace surface
features/           domain folders that own data loading and domain view state
ui/                 primitives only; no fetching, no domain knowledge
client-runtime/     auth, workspace selection, typed API/RPC, subscriptions,
                    cache invalidation, realtime event application
```

Dependency direction is `routes → features → ui` and `routes/features →
client-runtime`. Nothing in `ui/` imports a feature. Nothing in a primitive
accepts a domain object.

## 4. Route tree

```text
/                                    redirect to the active workspace
/workspaces                          workspace switcher and creation
/w/$workspaceId                      workspace home: people, employees, work
/w/$workspaceId/activity             cross-lane event and work activity
/w/$workspaceId/people               members, roles, invitations
/w/$workspaceId/employees            employee roster and readiness
/w/$workspaceId/employees/$employeeId
  ?tab=profile                       identity, instructions, responsibilities
  ?tab=versions                      configuration versions and rollout
  ?tab=tools                         exact grants, policy, readiness blockers
  ?tab=work                          assigned goals/tasks/runs
/w/$workspaceId/goals                goal list and ownership
/w/$workspaceId/goals/$goalId
  ?tab=overview                      outcome, owner, success criteria, status
  ?tab=plan                          plan and task tree
  ?tab=children                      child goals/tasks/delegation
  ?tab=outputs                       deliverables and provenance
/w/$workspaceId/tasks/$taskId        task detail and lane selection
/w/$workspaceId/approvals            approval inbox across the workspace
/w/$workspaceId/approvals/$approvalId
                                     exact frozen scope and evidence
/w/$workspaceId/runs/$runId
  ?tab=timeline                      events and progress
  ?tab=deliverables                  files, diffs, reports, links, versions
  ?tab=verification                  checks, proof, gaps, outcome-unknown state
  ?tab=receipts                      external effects and idempotency records
/w/$workspaceId/artifacts            artifact workspaces, files, notes, versions
/w/$workspaceId/integrations         connected apps and workspace grants
/w/$workspaceId/machines             paired local machines and dispatch state
/w/$workspaceId/computers            shared/dedicated computers and evidence
/w/$workspaceId/browser              browser profiles and sessions
/w/$workspaceId/memory               shared/private context, sources, revocation
/w/$workspaceId/automations          schedules, budgets, triggers, kill switch
/w/$workspaceId/audit                governance, receipts, exports
/w/$workspaceId/settings             workspace settings and danger zone
/settings                            user settings and auth
```

The exact route names can change during implementation. The required property is
that approvals, employees, goals, runs, deliverables, and publication receipts
are independently addressable.

## 5. Feature ownership

| Feature folder | Owns |
|---|---|
| `features/workspaces` | Workspace list, active workspace, membership, invitations |
| `features/employees` | Employee profiles, versions, readiness, skills, tool policy |
| `features/goals` | Goals, plans, task trees, ownership, parent/child progress |
| `features/approvals` | Approval inbox, frozen scope comparison, approve/reject/act-after-review |
| `features/runs` | Runs, attempts, cancellation, retry, lane events |
| `features/deliverables` | Files, diffs, reports, artifact versions, provenance, verification |
| `features/integrations` | Connections, workspace/member/employee grants, action receipts |
| `features/machines` | Local pairing, machine health, dispatch claims |
| `features/computers` | Dedicated/shared computers, browser control, evidence, takeover |
| `features/memory` | Memory/context visibility, sharing scope, revocation |
| `features/automations` | Automation definitions, schedules, budgets, manual trigger state |
| `features/audit` | Audit search, receipts, exports, governance evidence |

Cross-feature data goes through the client runtime or an explicit owner hook.
A component must not refetch a fact because it needs a badge.

## 6. Server state and UI state

Server state includes workspace records, employees, goals, tasks, approvals,
runs, deliverables, integrations, receipts, and audit events. Cache it in the
client runtime, invalidate it from realtime events, and keep one owner per
collection.

UI state includes composer drafts, selected rows, expanded panels, local filters,
and optimistic editing state. Keep it near the feature that uses it. Do not put
ephemeral UI state in a global store unless several routes truly share it.

Optimistic updates are allowed only when the action has a stable client mutation
and rollback path. Approval, cancellation, publication, integration mutation,
and machine/computer control must show pending and uncertain states honestly.

## 7. Approval card

The approval card is the primary review object. It must show:

- requester, workspace, employee, and employee version;
- exact task/action and target;
- resources and tools being granted;
- execution lane and runtime/model route;
- expiry, budget, and limits;
- context/memory sources included;
- diff or input summary when available;
- consequences of approval;
- reject, edit/replan, approve, and approve-and-publish states where applicable.

Approval cards must not hide scope behind prose. When a run is already executing,
show the frozen envelope beside live progress so drift is visible.

## 8. Run and deliverable rendering

A run page is evidence-first:

1. status and lane;
2. parent goal/task and approval;
3. live timeline;
4. deliverables;
5. verification;
6. receipts and publication state;
7. cancellation/retry controls.

Render artifacts by type. A diff, a campaign draft, a research report, a budget
worksheet, an operations checklist, and a browser transcript need different
viewers. They share provenance, versions, verification, and publication controls.

## 9. Component budget

Keep primitives small. Split a feature component when it becomes more than one
of these at the same time:

- list and detail;
- composer and reviewer;
- data owner and renderer;
- lane-specific viewer and shared evidence viewer.

Large legacy surfaces should be split by ownership, not only by line count. A
600-line component with one job can be acceptable. A 250-line component that
fetches, mutates, routes, formats, and renders five objects is not.

## 10. Implementation order

1. Add the workspace/employee/goal/task route skeleton.
2. Move approval inbox and approval detail onto shareable routes.
3. Create one client-runtime owner for workspace, employee, approval, and run
   collections.
4. Add deliverable and verification tabs to run detail.
5. Add artifact workspace surfaces.
6. Add integration grants and receipts.
7. Add machine/computer/browser authority surfaces.
8. Migrate legacy coding-run navigation under goals/tasks without deleting the
   existing deep links.
9. Add audit/export surfaces after receipts are stable.

Do not redesign visual styling at the same time as this structural migration.
First make the product objects legible. Then polish the interface.
