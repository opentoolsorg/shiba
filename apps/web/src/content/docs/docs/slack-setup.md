---
title: Slack setup
description: Install the Shiba Slack app, choose approvers, and connect channels to repositories.
---

This guide is for your installation administrator. For commands and task review, see [Slack](/docs/slack/).

## Create the app

In the [Slack app dashboard](https://api.slack.com/apps), create an app from the repository's `slack-app-manifest.yaml`. Replace the `YOUR-WORKER.workers.dev` hostname with your deployed Shiba hostname before importing it, then install the app in your workspace.

The manifest registers `/shiba`, subscribes to mentions and direct messages, and enables the message scopes Shiba uses. Reinstall the app after changing its scopes.

Keep `chat:write`, `chat:write.customize` and `reactions:write` among the bot scopes. Shiba uses `reactions:write` to acknowledge short thank-you replies with a check mark instead of another approval card. Existing installations need administrator review and reauthorization for the added scope.

### Attach result files

`files:write` lets an approved run attach its named deliverables, and a Slack image request attach its image, to the conversation that asked. The manifest includes it. Without it Shiba still posts replies and the dashboard link in the same thread, says once that files need an administrator, and attempts no upload.

To grant it:

1. In the Slack app, open **OAuth & Permissions** and add `files:write` under **Bot Token Scopes** — or re-import the updated manifest. Keep only the scopes you intend to grant.
2. Choose **Reinstall to Workspace** and approve the new scope list as a workspace admin.
3. For the bot-token connection, replace `SLACK_BOT_TOKEN` with the token Slack shows after that reinstall. Shiba reads the granted scopes from Slack, so an old token keeps posting text and stops attempting attachments.

Workspace-owner installations upgrade through **Settings → Integrations → Slack**: select `files:write`, prepare a new authorization request, and have a verified workspace owner review the scopes and activate the returned installation. Selecting the scope is not approval; nothing changes until that review finishes.

Files stay available in Shiba while the scope is missing, and nothing is silently retried later. Ask again after the reinstall to receive them in the conversation.

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

For the operator-provisioned bot, invite it to a test channel and mention it with a small task. Verify that an approval card appears in the same thread, an unlisted user cannot approve it, and rejecting it starts no work. Then approve a fresh request and look for the result in its originating thread. Use a repository URL for repository work, or `workspace:slack-check` for a repo-free test.

Test `/shiba workspace:slack-check <task>` separately. The approval card and, on a single-workspace deployment with private reply storage configured (`ATTACHMENTS`), the final text are private to the requester in that channel. Approve your own test command with an account on the approver list. Use a channel mention instead when another approver needs to see the card.

Repository selection uses the supplied URL or thread context, then the channel mapping. If no repository can be resolved, Shiba asks for one. A missing bot token prevents mention replies and starts no run.

Confirm model access and GitHub publishing separately. Use [Readiness](/docs/readiness/) for the deployment checks.

## Workspace-owner installations

The Slack installations panel uses a separate OAuth flow. Setting only `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` does not enable that panel. Its operator prerequisites are:

- `SLACK_INSTALLATIONS_ENABLED=true`, `SLACK_OAUTH_APP_ID` and `SLACK_OAUTH_CLIENT_ID` for the Slack app.
- `SLACK_SIGNING_SECRET` and `SLACK_OAUTH_REDIRECT_URI`, an HTTPS URL on your deployment ending in `/api/slack/installations/callback` with no query string.
- `SLACK_INSTALLATION_KEYRING`, a Worker secret containing JSON with `activeKeyId` and a `keys` map of one to three short key IDs to 32-byte hexadecimal encryption keys.
- `SLACK_OAUTH_PKCE_ENABLED=true` only after the administrator has enabled PKCE for the Slack app. This app setting requires Slack support to undo.
- `SLACK_OAUTH_QUERY_REDACTION_VERIFIED=true` only after the operator has configured and verified query-string redaction in invocation and access logs. The OAuth callback includes temporary authorization data in its query.

In the Slack app configuration, register the exact callback URL and subscribe to `app_uninstalled` and `tokens_revoked` at the Events API endpoint so Shiba can invalidate a disconnected installation.

Keep secrets in Cloudflare secrets or your server's secret store. The panel requires a verified native workspace owner to review bot scopes, install the app, and separately review and activate the returned installation. If you cancel in Slack, the existing installation is unchanged. To disconnect locally, review and choose **Disable in Shiba**; this doesn't uninstall the Slack app. To reconnect, review the scopes, prepare a fresh authorization, then activate the new pending revision. The panel does not grant employee execution or provider access and is not a way to provision the operator bot above. See [Getting a workspace ready](/docs/workspace-ready/) for the other setup cards.
