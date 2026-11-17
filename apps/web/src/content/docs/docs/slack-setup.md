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

## Workspace-owner installations

The Slack installations panel uses a separate OAuth flow. Setting only `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` does not enable that panel. Its operator prerequisites are:

- `SLACK_INSTALLATIONS_ENABLED=true`, `SLACK_OAUTH_APP_ID` and `SLACK_OAUTH_CLIENT_ID` for the Slack app.
- `SLACK_SIGNING_SECRET` and `SLACK_OAUTH_REDIRECT_URI`, an HTTPS URL on your deployment ending in `/api/slack/installations/callback` with no query string.
- `SLACK_INSTALLATION_KEYRING`, a Worker secret containing JSON with `activeKeyId` and a `keys` map of one to three short key IDs to 32-byte hexadecimal encryption keys.
- `SLACK_OAUTH_PKCE_ENABLED=true` only after the administrator has enabled PKCE for the Slack app. This app setting requires Slack support to undo.
- `SLACK_OAUTH_QUERY_REDACTION_VERIFIED=true` only after the operator has configured and verified query-string redaction in invocation and access logs. The OAuth callback includes temporary authorization data in its query.

Keep secrets in Cloudflare secrets or your server's secret store. The panel requires a verified native workspace owner to review bot scopes, install the app, and separately review and activate the returned installation. It does not grant employee execution or provider access. See [Getting a workspace ready](/docs/workspace-ready/) for the other setup cards.
