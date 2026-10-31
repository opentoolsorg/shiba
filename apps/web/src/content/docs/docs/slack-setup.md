---
title: Slack setup
description: Install the Shiba Slack app, choose approvers, and connect channels to repositories.
---

This guide is for your installation administrator. For commands and task review, see [Slack](/docs/slack/).

## Create the app

In the [Slack app dashboard](https://api.slack.com/apps), create an app from the repository's `slack-app-manifest.yaml`. Replace the `YOUR-WORKER.workers.dev` hostname with your deployed Shiba hostname before importing it, then install the app in your workspace.

The manifest registers `/shiba`, subscribes to mentions and direct messages, and enables the message scopes Shiba uses. Reinstall the app after changing its scopes.

## Configure delivery

| Slack setting | Shiba endpoint |
| --- | --- |
| Slash command request URL | `/api/slack/command` |
| Event subscriptions | `/api/slack/events` |
| Interactivity | `/api/slack/interact` |

Use HTTPS URLs on your Shiba hostname. The event subscription includes `app_mention` and `message.im`. Slack request signatures and timestamps are checked by the Worker.

## Configure access

Set these values through your deployment's configuration source:

- `SLACK_BOT_TOKEN`: the installed bot token, needed to reply to mentions and messages.
- `SLACK_SIGNING_SECRET`: the app's signing secret.
- `SLACK_APPROVERS`: comma-separated Slack user IDs allowed to approve or reject tasks. An empty list allows nobody.
- `SLACK_CHANNEL_REPOS` (optional): a JSON map from channel ID to an HTTPS GitHub repository URL.
- `SLACK_AGENT_HARNESS` (optional): the agent used for Slack tasks; otherwise Shiba uses `AGENT_HARNESS`, then `claude-code`.

Keep secrets in your deployment's secret configuration, not in URLs or channel messages. If you use Alchemy, maintain its environment source rather than relying on secrets written separately through Wrangler. See [Configuration](/docs/configuration/).

## Check the connection

Invite the bot to a test channel and send a small `/shiba` request with a repository URL. Confirm that an approval card appears, an unlisted user cannot approve it, and rejection starts no repository work. Then test one approved task and inspect the returned result.

Repository selection uses the supplied URL or thread context, then the channel mapping. If no repository can be resolved, Shiba asks for one. A missing bot token prevents mention replies and starts no run.

Confirm model access and GitHub publishing separately. Use [Readiness](/docs/readiness/) for the deployment checks.
