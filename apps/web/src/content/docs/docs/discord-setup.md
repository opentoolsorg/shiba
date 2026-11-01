---
title: Discord setup
description: Connect Discord interactions, register the task command, and configure approvers.
---

This guide is for your installation administrator. For task commands, see [Discord](/docs/discord/).

## Create the app

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its public key and create the bot credentials needed to post updates.

Set the **Interactions Endpoint URL** to:

```text
https://your-shiba.example.com/api/discord/interactions
```

The Worker validates Discord's signed ping before acknowledging it. Ensure your deployment's access rules let the interaction reach this signature-checked handler.

## Configure access

Set these values through your deployment's configuration source:

- `DISCORD_PUBLIC_KEY`: the application's public key for request verification.
- `DISCORD_BOT_TOKEN`: the bot token used to post progress and outcomes.
- `DISCORD_APPROVERS`: comma-separated Discord user IDs allowed to approve work. An empty value allows nobody.
- `DISCORD_CHANNEL_REPOS` (optional): a JSON map from channel ID to an HTTPS GitHub repository URL.
- `DISCORD_AGENT_HARNESS` (optional): the agent for Discord tasks; otherwise Shiba uses `AGENT_HARNESS`.

Keep credentials out of task text and webhook URLs. See [Configuration](/docs/configuration/) for deployment secret handling.

## Register the command

Register the `shiba` application command with Discord using your chosen application-management tool. It accepts these string options:

| Option | Required | Purpose |
| --- | --- | --- |
| `task` | Yes | Work to request |
| `repo` | No | HTTPS GitHub repository URL; may be omitted for a mapped channel |

Install the app with command access in your test server. Command availability in direct messages also depends on how the application was installed and configured.

## Check task approval

Run a small `/shiba` request. Shiba first acknowledges the interaction, then presents an approval card. A long task may continue in additional messages so the approver can read it in full.

Confirm that only an allowed user can decide, a repeated decision does not start another run, and rejection starts no repository work. Then test a separate approved request and inspect the outcome.

Each channel has its own conversation. Approval buttons decide that channel's pending request; the dashboard approval list does not aggregate Discord conversations. The bot posts progress and outcomes when it can deliver messages.

For deployment checks, see [Readiness](/docs/readiness/).
