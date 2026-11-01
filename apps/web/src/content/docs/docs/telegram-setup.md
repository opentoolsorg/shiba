---
title: Telegram setup
description: Connect a Telegram bot and choose who may approve work in each chat.
---

This guide is for your installation administrator. For task commands, see [Telegram](/docs/telegram/).

## Create and configure the bot

Create a bot with [@BotFather](https://t.me/BotFather), then store its token as `TELEGRAM_BOT_TOKEN` in your deployment's secret configuration.

Also configure:

- `TELEGRAM_WEBHOOK_SECRET`: a random shared secret used to verify incoming updates.
- `TELEGRAM_APPROVERS`: comma-separated Telegram user IDs allowed to approve work. An empty value allows nobody.
- `TELEGRAM_CHAT_REPOS` (optional): a JSON map from chat ID to an HTTPS GitHub repository URL.
- `TELEGRAM_AGENT_HARNESS` (optional): the agent for Telegram tasks; otherwise Shiba uses `AGENT_HARNESS`.

Use your chosen deployment configuration source. Do not paste secrets into a task or chat. See [Configuration](/docs/configuration/).

## Register delivery

Register the bot's webhook with Telegram's `setWebhook` method. Use this Shiba URL:

```text
https://your-shiba.example.com/api/telegram/webhook
```

Pass the shared secret as Telegram's `secret_token` registration parameter. Telegram then sends it in the `X-Telegram-Bot-Api-Secret-Token` request header. Never append the secret to the Shiba webhook URL. Subscribe to `message` and `callback_query` updates.

The Worker rejects updates with a missing or incorrect secret and deduplicates repeated update IDs. Delivery must reach the handler through your deployment's access configuration.

## Check task approval

Send a small `/shiba <repository-url> <task>` request in a test chat. Confirm that the proposed task and repository are visible, only an allowed user can decide, and rejection starts no repository work. Approve a separate test request and inspect the result.

Each chat has its own conversation. Approval buttons resolve that chat's pending request; the dashboard approval list does not aggregate Telegram conversations. Progress and terminal outcomes are posted back to the chat when the bot can deliver messages.

A group command can use `/shiba@YourBot`. `/start` and `/help` show usage. A mapped chat can use `/shiba <task>` without repeating the repository URL.

For a rollout checklist, see [Readiness](/docs/readiness/).
