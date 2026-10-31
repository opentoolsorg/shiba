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

## Conditional requests

A trigger can include a `runWhen` condition, such as “the issue is a bug report, not a feature request.” The planning model checks that condition before a run is requested.

The condition fails closed: an error, empty answer, or unrecognized answer skips the request and records the reason. Model and platform usage can still incur charges.

## Approval and limits

Automated runs require approval by default. A schedule or event does not grant permission to execute a task.

The existing advanced unattended mode is a separate, explicit operator opt-in. It requires `unattended: true`, an exact repository entry in `unattendedRepos`, and a pull-request-only request. If those restrictions do not hold, the run still needs approval. It does not authorize arbitrary external mutations or automatic merging. The recipe gallery does not enable this mode.

| Control | Behavior |
| --- | --- |
| `dailyRunLimit` | Defaults to 20 requests per automation per UTC day. Further requests are refused with a reason. |
| Schedule floor | At least five minutes between firings. |
| Shared run limit | The configured global limit is five concurrent runs. Excess requests are refused rather than guaranteed to wait. |
| `enabled: false` | Disables an automation when stored in its configuration. |
| `AUTOMATIONS_ENABLED` | Deployment-wide switch; `false`, `0`, `off`, or `no` disables automation execution. |

These are application controls, not a guarantee of account capacity or price. Review [Costs](/docs/costs/) and your hosting account limits.

## Source and verification

Trigger matching and authorization live in `apps/backend/src/automations.ts`; requests are dispatched by `automation-runner.ts` and the `Automations` Durable Object. The dashboard recipe flow lives in `apps/frontend/src/components/AutomationsView.tsx`.

Implemented configuration and unit tests do not establish a working live integration. Use the [readiness checklist](/docs/readiness/) when validating your deployment.
