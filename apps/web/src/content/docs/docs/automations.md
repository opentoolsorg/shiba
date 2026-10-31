---
title: Automations
description: Set up recurring work and tasks that respond to events.
---

Use automations for work you want to request repeatedly, such as a weekly dependency check or a review when a pull request opens.

## Start with a recipe

1. Open **Automations** and find the **Recipe Gallery**.
2. Enter the GitHub repository where the work should happen.
3. Optionally choose a bot to provide its standing instructions.
4. Read a recipe's task and schedule or event, then choose **Deploy recipe**.

The recipe appears under **Deployed Automations** after it is saved. Setting up a recipe schedules requests; it does not approve their execution.

## Choose when work is requested

The gallery includes recipes for nightly lint fixes, weekly dependency checks, documentation updates, and pull request reviews. Other recipes respond to configured Slack messages or wait for you to start them.

Recipes have preset tasks and triggers. Ask your administrator if you need a different schedule, event, or prompt. Connected services must be set up before their events can reach Shiba.

## Follow an automated task

When a recipe requests work, review its approval card as you would for a task you started yourself. After approval, follow the thread and inspect the result.

For a recipe with a manual trigger, choose **Run now** in **Deployed Automations**. If the request is skipped, read the reason shown there before trying again.

If you want to change or stop recurring requests, ask your administrator to update the automation. Advanced setup and operator controls are described in the [automation reference](/docs/automation-reference/).

Continue with [Approvals](/docs/approval-gates/) or [Threads and results](/docs/dashboard/).
