---
title: Linear setup
description: Configure Linear agent-session delivery and understand the current connection limits.
---

This guide is for your installation administrator. For the user flow, see [Linear](/docs/linear-agent-session/).

Linear support is still being validated against live workspaces. Treat a configured app or successful webhook response as a setup check, not proof of a complete task round trip.

## Configure session delivery

Configure your Linear application to send agent-session events to:

```text
https://your-shiba.example.com/api/linear/webhook
```

Set `LINEAR_WEBHOOK_SECRET` on Shiba and configure matching signed delivery in Linear. The Worker checks the `linear-signature` or `x-linear-signature` header. Keep the secret out of the URL.

`LINEAR_ALLOW_UNSIGNED_WEBHOOK` is for local mocks only. Do not use it to expose an unsigned public endpoint.

Set `LINEAR_DEFAULT_REPO_URL` to the HTTPS GitHub repository for delegated work. Without the repository mapping, the direct agent-session path cannot queue its task.

## Configure outbound access

Shiba uses `LINEAR_API_KEY` or `LINEAR_OAUTH_ACCESS_TOKEN` to send an initial thought activity acknowledging the session. Without a token, that acknowledgement is skipped. Store credentials through your deployment's secret configuration; see [Configuration](/docs/configuration/).

Register and authorize your app according to [Linear's agent guide](https://linear.app/developers/agents) and [OAuth guidance](https://linear.app/developers/oauth-2-0-authentication). This Shiba reference is not a complete Linear OAuth installation guide.

## Event behavior

The handler accepts `created` and `prompted` sessions. It builds the requested task from the issue context or follow-up message, then sends it to the automation and approval flow. Matching automations can also use `linear.issue.delegated` and `linear.session.prompted` events.

The pending request remains subject to human approval. An initial Linear acknowledgement is not approval and does not mean execution succeeded.

## Current limits and checks

Do not rely on a final response or pull request link being written back to the Linear session. The source contains the acknowledgement and task queueing paths, not a complete outbound session-update workflow.

Use a test issue to verify signed delivery, repository selection, approval, rejection, and the eventual result in Shiba. Also check configured automations so the same issue does not unintentionally match more than one workflow. Review [Readiness](/docs/readiness/) before a live rollout.
