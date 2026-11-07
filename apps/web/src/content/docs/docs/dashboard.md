---
title: Threads and results
description: Keep each employee's brief, progress, decisions, and outputs in one conversation.
---

A thread is the home for a task and its follow-ups. Start one from the dashboard or select **Launch bot** from [Agents](/docs/employees/) to use an employee's saved instructions.

## Choose the kind of work

Use **Work** mode when you want the employee to use task tools. **Chat** mode is for conversation without task tools.

The work target determines what the task can do:

| Work target | Use it for |
| --- | --- |
| **Artifact workspace** | Create reviewable documents and files without GitHub. |
| **Repository task** | Work in an existing GitHub repository and branch. |
| **Employee tools and supplied context** | Work from a linked brief or app resources explicitly granted to the employee, without a repository. |

Check the selected model, account, and runtime. Cloud work needs a configured runtime; local work needs a compatible paired computer. Available tools depend on the employee and your installation.

## Send a useful brief

State the outcome, audience, sources, and how you will judge the result. Add relevant [skills](/docs/skills/) and keep the request small enough to review.

For workspace runs, read the approval card before work begins. Check the target, task, output files, and publishing choice. Connected app work follows its separate tool permissions and action approvals; selecting it does not grant access.

## Find the result

Read the response and any **Run progress**, **Deliverables**, **Pull request**, or **Review findings** panels shown in the thread.

- **Artifacts** are the files a task produced. Open the captured deliverables or **Download artifacts ZIP** when available. A download or file-presence check does not verify the content's accuracy.
- **Repository changes** appear as files and a diff. Check deletions, renamed files, and reported tests.
- **App results** depend on the permitted tools used. Read their results and any action receipts rather than assuming a requested action succeeded.

Artifact ZIP links expire after seven days. Download useful work while the link is available, and read any missing-file, size-limit, or expiry notice.

## Review, then decide

Check facts and sources, read the changed files, and distinguish passed checks from failed or unrun checks. A completed status is not a guarantee of correctness.

Reply in the same thread with a specific correction. Start another thread for unrelated work. Requesting a pull request does not publish it immediately: Shiba asks for a separate publication approval of the completed changes. See [Pull request review](/docs/review/).

## Cancel or clear

Cancel from the task's controls when you want work to stop. Check its status before starting replacement work; cancellation may take time.

**Clear conversation** asks for confirmation. Cancel active work first: clearing a conversation does not stop it. If Shiba reports a partial clear, refresh and check what remains.

## More task options

<span id="execution-settings"></span>
<span id="reasoning-effort"></span>
<span id="repo-setup"></span>
<span id="environment-variables"></span>

For effort levels, setup scripts, and test environment values, see [Task settings](/docs/task-settings/). For your own computer, see [Remote access](/docs/remote-access/). If something is missing, start with [Common questions](/docs/troubleshooting/).
