---
title: Automations
description: Set up recurring work and tasks that respond to events.
---

Use automations for work you want to request repeatedly, such as a weekly dependency check or a review when a pull request opens.

## Start with a recipe

1. Open **Automations** and find the **Recipe Gallery**.
2. Enter the GitHub repository where the work should happen.
3. Optionally choose an AI employee (labeled **bot** in this picker) to provide its standing instructions.
4. Read a recipe's task and schedule or event, then choose **Deploy recipe**.

The recipe appears under **Deployed Automations** after it is saved. Setting up a recipe schedules requests; it does not approve their execution.

## Choose when work is requested

The gallery includes recipes for nightly lint fixes, weekly dependency checks, documentation updates, and pull request reviews. Other recipes respond to configured Slack messages or wait for you to start them.

Recipes have preset tasks and triggers. Ask your administrator if you need a different schedule, event, or prompt. Connected services must be set up before their events can reach Shiba.

## Follow an automated task

When a recipe requests work, review its approval card as you would for a task you started yourself. After approval, follow the thread and inspect the result.

For a recipe with a manual trigger, choose **Run now** in **Deployed Automations**. If the request is skipped, read the reason shown there before trying again.

## Pause or change an automation

Choose **Disable** on the automation in **Deployed Automations** to stop future requests. Choose **Enable** when you want them to resume. Disabling does not cancel a request already queued for approval or a run already in progress; a trigger already being evaluated may also queue an approval afterward. Inspect existing requests and runs, then check again for late-arriving approvals and reject or cancel them as needed.

If the employee profile has changed since the automation was saved, a dispatch can be skipped as stale rather than silently using new instructions. Attached reviewed skills are stored snapshots: editing or disabling the original library skill does not automatically update that saved automation. Review and update the automation itself when its instructions should change.

Ask your operator to change schedules or settings that the gallery does not expose. The gallery currently starts from a GitHub repository. The advanced API also supports scheduled artifact-workspace requests, but connected-app automation execution is unavailable. See the [automation reference](/docs/automation-reference/).

## Know when usage begins

A condition such as “run only for a bug report” may be evaluated before a run reaches human approval. That evaluation can send event or task context to the configured condition service and incur usage even if no workspace run starts. Use specific conditions, review connected event sources, and check the operator’s cost settings.

Continue with [Approvals](/docs/approval-gates/) or [Threads and results](/docs/dashboard/).
