---
title: Automation configuration reference
description: Trigger configuration, limits, and operator controls for Shiba automations.
---

For the dashboard recipe gallery, use [Automations](/docs/automations/). This reference is for operators configuring triggers or integrating another service.

## Trigger kinds

An automation supports up to 20 triggers. A matching trigger can request a run, subject to the automation's conditions and limits.

| Kind | Configuration |
| --- | --- |
| `schedule` | A five-field cron expression. Firings have a five-minute minimum gap; missed ticks coalesce. |
| `github` | Configured GitHub events delivered through the verified webhook. |
| `slack` | Configured Slack message or burst conditions. |
| `webhook` | An authenticated request to `POST /api/automations/{id}/trigger`. |
| `manual` | A request from **Run now** or `POST /api/automations/{id}/run`. |

Create a record with `POST /api/automations`, using your installation's dashboard authentication. The recipe gallery exposes preset configurations rather than every field.

```json title="Example automation configuration"
{
  "id": "nightly-dep-audit",
  "prompt": "Audit dependencies for known vulnerabilities and report the checks run",
  "repoUrl": "https://github.com/org/web-app",
  "enabled": true,
  "triggers": [
    { "kind": "schedule", "cron": "0 2 * * *" }
  ]
}
```

The per-automation webhook secret is returned only when the automation is created. Send it in the `x-automation-secret` header. Query-string secrets are not accepted.

## Work targets and pinned instructions

The recipe gallery uses repository tasks. The API accepts an explicit `executionTarget` for either a repository or an artifact workspace:

- **Repository:** the target repository must match `repoUrl` when both are supplied.
- **Artifact workspace:** omit `repoUrl`; only schedule triggers are accepted. The run cannot request a pull request or connected-app mutations.
- **Connected app:** rejected until a permissioned automation adapter is available.

Custom employee schedules require a reviewed profile-version pin. Before dispatch, Shiba resolves the current employee profile and compares its version/hash; a changed or unavailable profile causes a recorded skip.

Attached reviewed skills are stored instruction snapshots. Dispatch checks each saved pin’s enabled flag and content hash, then uses those stored instructions. This is not a live lookup of the original skill library: editing or disabling a library skill does not automatically update or revoke the automation’s saved snapshot. Review and update the automation when those instructions should change.

## Conditional requests

A trigger can include a `runWhen` condition, such as “run for GitHub issues with the `bug` label.” For GitHub events, the condition can inspect the event name and action, repository, branch, author, and labels; issue titles and bodies are not included. The condition is evaluated before the coding-run approval is queued. With `TYPESAFE_API_KEY` configured, Shiba uses TypeSafe Noul; otherwise it uses the configured Workers AI planning model. Event/task context used for the check is sent to that service even though execution still needs human approval.

The condition fails closed: an error, empty answer, or unrecognized answer skips the request and records the reason. Model and platform usage can still incur charges.

## Approval and limits

Every automated run requires explicit human approval. A schedule or event does not grant permission to execute a task.

Legacy `unattended` and `unattendedRepos` fields remain readable for compatibility. They cannot approve a run or authorize an external mutation. Publishing completed changes requires a separate human approval of the frozen file snapshot.

| Control | Behavior |
| --- | --- |
| `dailyRunLimit` | Defaults to 20 requests per automation per UTC day. Further requests are refused with a reason. |
| Schedule floor | At least five minutes between firings. |
| Run concurrency | Dispatch uses the current orchestrator run registry: five active runs by default, or ten with `SHIBA_ELEVATED_CONCURRENCY`. This is separate from the deployment container ceiling. Excess requests can be refused rather than guaranteed to wait. |
| `enabled: false` | Disables an automation when stored in its configuration. |
| `AUTOMATIONS_ENABLED` | Deployment-wide switch; `false`, `0`, `off`, or `no` disables automation execution. |

These are application controls, not a guarantee of account capacity or price. Review [Costs](/docs/costs/) and your hosting account limits.

## Source and verification

Trigger matching and authorization live in `apps/backend/src/automations.ts`; requests are dispatched by `automation-runner.ts` and the `Automations` Durable Object. The dashboard recipe flow lives in `apps/frontend/src/components/AutomationsView.tsx`.

Implemented configuration and unit tests do not establish a working live integration. Use the [readiness checklist](/docs/readiness/) when validating your deployment.
