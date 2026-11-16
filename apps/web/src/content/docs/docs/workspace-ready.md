---
title: Getting a workspace ready
description: The setup cards you may see, what each one needs, and where to set it.
---

Shiba shows a setup card instead of failing after you submit. Each card names what is missing. Values are never shown; set them in your deployment's secret store (Cloudflare secrets or your server's environment). Check the current state at `GET /api/setup/status`.

## Connect ChatGPT or Claude to run tasks

Shown above the task composer, in the first-run wizard and in Needs you. Send is disabled until the workspace has one of:

- a personal provider linked in Settings → Providers (ChatGPT or Claude sign-in, or your own API key),
- a ready model connection, or
- `AI_GATEWAY_TOKEN` on the deployment.

`modelRoute` in `/api/setup/status` reports `ready`, which route is used (`personal-provider`, `connection` or `gateway`), and a `fix` link when nothing is set.

## Set up Slack

Shown in Settings and in the Slack installations panel when Slack is not installed.

1. Create a Slack app from `slack-app-manifest.yaml`.
2. Add `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` as secrets. `SLACK_APPROVERS` and `SLACK_CHANNEL_REPOS` are covered in [Slack setup](/docs/slack-setup/).
3. Install the app in your Slack workspace.

Workspace-owner installs through the panel also need the operator-side Slack OAuth settings described in [Slack setup](/docs/slack-setup/).

## Tools that need setup

The employee tool policy view lists these tools with a "Needs setup" chip when the key or binding is missing (`toolSetup` in `/api/setup/status`):

| Tool | Needs |
| --- | --- |
| Web search | `WEB_SEARCH_API_KEY` (and optionally `WEB_SEARCH_PROVIDER`: `tavily`, `exa` or `brave`) |
| Image generation | the `AI` Workers AI binding and `FILES` or `ARTIFACTS` output storage binding |
| Browser | the `BROWSER` Browser Rendering binding |

On Cloudflare, set secrets with `wrangler secret put NAME` and bindings in your Worker config. On any other server, set API keys in your server's secret store or environment; Workers AI, output storage and browser bindings need runtime service adapters rather than string environment values.
