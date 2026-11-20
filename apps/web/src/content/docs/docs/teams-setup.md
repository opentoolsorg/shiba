---
title: Microsoft Teams setup
description: Register the Teams bot, install the Shiba custom app, and configure approval for repository tasks.
---

Use this guide to connect a self-hosted Shiba Worker to **one Microsoft Teams tenant and one native Shiba workspace**. This setup is for the public commercial Teams cloud, not a sovereign cloud. You’ll need someone who can configure the Azure Bot and Worker, a Teams user allowed to install the custom app, and a native Shiba workspace owner who can enable the connection.

Before setting up Teams, make sure the Worker has [GitHub access](/docs/github-setup/) for the repository you’ll use and [model provider access](/docs/model-auth/) for the chosen agent harness. The Teams app does not configure either one.

The native workspace owns the connection controls, not the execution authority. Approved Teams tasks use the deployment’s self-hosted runtime, GitHub access, and model configuration. Teams does not use workspace-scoped execution grants.

## 1. Register a single-tenant Azure Bot

1. In the Azure portal, create an **Azure Bot** using the **Single Tenant** app type. If you use an existing Microsoft Entra app registration, choose one in the same tenant with **Accounts in this organizational directory only**. Copy the Application (client) ID and Directory (tenant) ID.
2. In the Entra app registration, create a client secret. Save its **value**, not the secret ID, in your deployment’s secret store.
3. In the Azure Bot’s **Configuration**, set the **Messaging endpoint** to `https://your-shiba.example.com/api/teams/messages`, using your Worker’s public HTTPS hostname. The Connector sends `POST` requests here. If the Worker is behind an interactive sign-in policy, allow the Connector to reach this exact path without a browser session and forward its `Authorization` header. Shiba verifies the signed Bot Connector token; keep dashboard access protected.
4. In the Azure Bot’s **Channels**, enable **Microsoft Teams**. Select the public commercial cloud for messaging if prompted.

## 2. Configure the Shiba Worker

Set these through your [deployment configuration](/docs/configuration/):

| Name | Where to set it | Value |
| --- | --- | --- |
| `TEAMS_APP_ID` | Worker secret | The Azure Bot’s Microsoft App ID, which is the Entra Application (client) ID. |
| `TEAMS_APP_PASSWORD` | Worker secret | The Entra client secret **value**. |
| `TEAMS_APP_TENANT_ID` | Worker environment variable | The Entra Directory (tenant) ID for the Teams tenant. |
| `TEAMS_WORKSPACE_ID` | Worker environment variable | The selected native Shiba workspace’s `ws_…` ID, not its display name or a Teams ID. |
| `TEAMS_APPROVERS` | Worker environment variable | Comma-separated Entra **user object IDs** from that tenant. Use the Object ID from each user’s Entra record, not their email, Teams user ID, or app ID. At least one approver is required to enable Teams. |
| `TEAMS_CHANNEL_REPOS` | Optional Worker environment variable | JSON mapping the exact Teams activity `conversation.id` (not the channel name or team ID) to a canonical repository URL. For example: `{"19:example@thread.tacv2":"https://github.com/owner/repo"}`. A repository URL in the request takes precedence. |
| `TEAMS_AGENT_HARNESS` | Optional Worker environment variable | Override the deployment’s `AGENT_HARNESS` for Teams tasks. If omitted, Teams uses `AGENT_HARNESS`. |

Never include the client secret in the Teams package, a message, or the endpoint URL.

To find a workspace ID, sign in to Shiba and open `/api/workspaces` on your dashboard hostname. Find the workspace by name and use its `workspaceId`. Apply the Teams connection D1 migration along with the rest of the deployment migrations.

## 3. Enable Shiba and install the app in Teams

1. Sign in to Shiba as a native workspace owner with a verified email address and select the workspace configured in `TEAMS_WORKSPACE_ID`. Open **Integrations → Manage Microsoft Teams connection** and select **Enable Teams in Shiba**. This enables the Worker connection; it does not upload or install the Teams app.
2. From your Shiba repository checkout, use Python 3 to build the install ZIP. Replace `YOUR_MICROSOFT_APP_ID` with the same Microsoft App ID used for `TEAMS_APP_ID`. The builder sets both manifest IDs and packages the manifest and two icons. It does not read your Worker secrets.

   ```sh
   python3 apps/web/scripts/package-teams-app.py "YOUR_MICROSOFT_APP_ID"
   ```

   The upload file is `apps/web/.build/teams/shiba-teams.zip`. Rebuild it if the bot’s App ID changes.

3. In Teams desktop or web, go to **Apps → Manage your apps → Upload an app → Upload a custom app** and choose the ZIP. Add the app for yourself, to a team, or to a group chat, depending on where you’ll use it. If upload or installation isn’t available, ask your Teams admin to allow custom apps for the installer and target scope or upload and make the app available through the organization’s app catalog.
4. In Shiba, select **Refresh Teams status**. **Teams installation** is separate from **Shiba connection**: Shiba reports **Installation observed** after receiving a signed `installationUpdate` add event. It means Shiba observed an installation, not that the app was added to every conversation.

## 4. Try a task and check the approval

In a channel or group chat, use the real Teams **@Shiba** mention; plain, unmentioned messages are ignored. For example:

```text
@Shiba https://github.com/owner/repo Summarize how the tests are organized.
```

In a one-to-one chat with Shiba, send the question directly: `https://github.com/owner/repo Where are the tests defined?` No mention or command is needed. Include a GitHub repository URL unless you’ve mapped that exact conversation. Keep the task itself to **1,500 characters** so the approval card can show the full text.

Shiba posts an Adaptive Card in the originating conversation with **Approve** and **Reject** (`Action.Submit`). Only users in `TEAMS_APPROVERS` can decide. Nothing starts before approval. Try rejecting a small request first, then approve a new one and check for the completed run summary in the same conversation. Teams approval authorizes the run only. It does not open a GitHub pull request, and separate publication approval is not available in Teams.

## Disable or remove the app

To stop processing Teams tasks, select **Disable Teams in Shiba** in the connection panel. This does not uninstall the app. Existing approval cards cannot be used after disablement and do not become valid when you re-enable the connection. A run approved before disablement may continue. Shiba suppresses replies from the old connection, but a reply already being sent can still arrive.

Re-enabling does not re-queue a Teams message Shiba already accepted. Send a new message to request the task again.

To remove the app from a chat or team, uninstall it in Teams as a separate action. Shiba records signed installation and removal events independently of whether the connection is enabled. Use **Refresh Teams status** to see the last observed installation state.
