---
title: Threads and results
description: Give Shiba a task, approve the request, and review the result.
---

Open the [dashboard](/app/) and sign in. Use **Threads** to start work and return to your conversations.

## Start a task

1. Open a thread, or select **Launch bot** from [Bots](/docs/employees/) to use an employee's saved instructions.
2. Choose a GitHub repository and base branch. Describe what you want changed and how to check it.
3. Review the selected agent and connection. Leave **Create pull request** off for your first task.
4. Add any [skills](/docs/skills/) you want, then send the message.

Keep the task small enough to review: fix one bug, draft one campaign, or investigate one question. Work is returned as changes or draft files in the repository.

## Approve the request

Read the **exact request** on the approval card before work starts. Check the repository, branch, task, settings, and whether a pull request will be created.

Approve the request you intend to run, or reject it and clarify the task. You can also find waiting decisions in **Approvals**.

## Review the result

Stay in the thread to follow progress and read the response. Open the returned files and diff, then check what passed, failed, or could not be checked.

The thread may show **Run progress**, **Pull request**, and **Review findings** panels when those results are available. A completed status is a starting point for review, not proof that every result is correct.

If something needs another pass, reply in the same thread with a specific correction. Start another thread for unrelated work.

## Cancel or clear

Cancel from the task's controls when you want work to stop. Check the task status before starting replacement work; cancellation may take time.

**Clear conversation** asks for confirmation. Cancel active work first: clearing a conversation does not stop it. If Shiba reports a partial clear, refresh and check what remains.

## More task options

<span id="execution-settings"></span>
<span id="reasoning-effort"></span>
<span id="repo-setup"></span>
<span id="environment-variables"></span>

For effort levels, setup scripts, or test environment values, see [Task settings](/docs/task-settings/). These options are usually unnecessary for a first task.

To run on your own computer, see [Remote access](/docs/remote-access/). If a connection or result is missing, start with [Troubleshooting](/docs/troubleshooting/).
