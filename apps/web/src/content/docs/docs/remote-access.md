---
title: Remote access
description: Connect your computer and choose it for approved local tasks.
---

Use **Remote Access** to connect a computer you want Shiba to work on. The page shows its connection status and available agents.

If it says **Local runtime is disabled**, ask your Shiba operator to enable it using the [setup guide](/docs/remote-access-setup/).

## Connect a computer

1. Open **Remote Access** in the dashboard.
2. In Shiba Desktop, select **Connect this computer**. In a browser, select **Add computer** and follow the displayed command on the computer you want to connect.
3. Wait for the computer to appear in the list. Check its status and available agents.

The connect command works once and expires after 15 minutes. If it expires, generate another from **Add computer**.

## Run a task locally

1. Open a thread and choose the repository and task.
2. Open the **Cloud** or **Local** selector and choose **Local (Paired computer)**.
3. Choose an online computer with a compatible agent.
4. Send the task, then review and approve the **exact request** before work starts.

Connecting a computer does not approve work on it. Review the returned changes in the thread, just as you would for a cloud task.

## Understand the status

| Status | What to do |
| --- | --- |
| Idle | The computer is connected and has reported no active task. |
| Busy | Check its current task before sending more work. |
| Offline | Make sure the computer is awake, connected to the internet, and running Shiba. |

Status can take a little time to update. Check the task's thread for progress. A listed agent is not a guarantee that its sign-in or connection is ready.

## Disconnect a computer

Select **Revoke** beside it and confirm. On Shiba Desktop, **Disconnect this computer** is also available from the tray menu.

Revoking access does not guarantee an active process stops immediately. Cancel and check active work before retiring the computer.

## Setup and troubleshooting

<span id="turn-it-on"></span>
<span id="cloudflare-access"></span>
<span id="pair-a-machine"></span>
<span id="files-on-the-machine"></span>
<span id="heartbeat-and-status"></span>
<span id="revoke-a-machine"></span>
<span id="desktop-app"></span>
<span id="install"></span>
<span id="first-run"></span>
<span id="connect-this-computer"></span>
<span id="tray-states"></span>
<span id="logs"></span>
<span id="notifications"></span>
<span id="start-at-login-and-quitting"></span>
<span id="uninstall"></span>
<span id="security-model"></span>
<span id="limits"></span>

For operator configuration, command-line setup, desktop logs, or connection errors, use the [Remote access setup reference](/docs/remote-access-setup/).
