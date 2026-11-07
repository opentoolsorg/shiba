---
title: Give your first task
description: Ask an AI employee for a useful draft, approve the work, and review the result.
---

Start with one small outcome you can check. This guide uses a launch brief, but the same approach works for a research summary, checklist, or product specification.

## 1. Choose an employee

Sign in to your Shiba workspace. Open **Agents**, choose an employee, and select **Launch bot** to start a thread with its saved instructions. You can also start a thread directly.

An AI employee is a saved role and set of instructions. Some controls still use the word “bot.” If you need to create one, follow [AI employees](/docs/employees/).

Need a workspace first? Ask the person who manages your installation or follow [Self-hosting](/docs/self-hosting/).

## 2. Choose a place for the output

In **Work** mode, choose **Artifact workspace** as the work target. Give it a name, such as “Product launch.” This creates files without requiring a GitHub repository.

For a simple cloud task, you can leave **Output files** blank and ask the employee to save its drafts in the output folder. Shiba collects the final files as an artifact download. If you select a local computer, list the output files you want returned and check that the computer is connected.

Working on existing code instead? Choose **Repository task**, select the GitHub repository and branch, and leave **Create pull request** off for your first task.

## 3. Give a clear brief

Tell the employee the outcome, audience, useful context, and limits. For example:

> Draft a one-page launch brief for solo developers. Use the product notes below, separate facts from assumptions, and suggest three announcement options. Save the draft in out/launch-brief.md. Don't publish or send anything.

Add your product notes to the request. Ask the employee to flag missing information rather than invent it. Never include passwords, API keys, or account tokens in a brief.

## 4. Approve the request

Read the approval card. Check the task, work target, model connection, output files, and any requested publication.

Approve it if it matches your intent. Otherwise, reject it and revise the brief. Creating an employee or sending a message does not approve a workspace run.

## 5. Review the result

Open the returned files or artifact download. Check the facts, missing information, and any reported tests. A completed task still needs your review.

Ask for a specific revision in the same thread. If you requested a pull request, review the separate publication approval after the changes are ready; approving the initial run does not publish them.

For named files, you can save a review and create a separate revision approval from the file card. See [Files and revisions](/docs/artifacts/) for the exact steps and output limits.

Next: [Work with your employees](/docs/employees/), [understand results](/docs/dashboard/), or [connect useful tools](/docs/connections/).
