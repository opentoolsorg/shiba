---
title: AI employees
description: Give each AI employee a role, instructions, and a clear definition of good work.
---

An AI employee is a reusable profile for a job you want help with. It brings a name, instructions, model connection, and task defaults into a conversation. You provide the goal and review the work.

Open **Agents** in the dashboard to manage your employees. Some buttons and forms still call them “bots.”

## Start with a role

Choose a role for the outcome you need:

| Employee | A good first assignment |
| --- | --- |
| Marketing | Draft a launch brief and three announcement options from product notes. |
| Sales | Prepare an account brief or outreach draft from supplied information. |
| Research | Answer one question, cite the evidence, and list what remains uncertain. |
| Operations | Turn a process into a checklist or handoff. |
| Product and design | Write a specification, user flow, or interface copy for review. |
| Engineering | Fix a specific bug and add a relevant test. |
| QA | Prepare a test plan and report which checks were actually run. |
| Finance | Draft a budget or performance summary from figures you provide. |

Use an available [employee template](/docs/templates/) or write custom instructions. Role names describe responsibilities; they do not connect accounts, grant tools, or guarantee that a task can be completed.

## Create your employee

1. Open **Agents** and choose a role or start with your own instructions.
2. Give it a name and unique slug, the short identifier used by Shiba.
3. Describe its responsibilities, source requirements, and what it should leave for your review.
4. Choose an available **Model connection** and review the run settings. A default GitHub repository is optional.
5. Check **Required deliverables**, the files you expect returned, then select **Create bot**.

For example, a marketing employee's instructions could be:

> Turn approved product notes into clear launch drafts for solo developers. Cite factual claims, label assumptions, and flag missing evidence. Keep campaigns and outreach as drafts unless a specific action is approved.

Use **Edit bot** to change the profile later. Use [skills](/docs/skills/) for a checklist or writing guide you want to reuse across employees.

## Give it a task

Select **Launch bot** and describe the outcome. Choose an artifact workspace for files without a repository, a repository for codebase work, or employee tools and supplied context when the needed app permissions are available.

Review the exact request before approving a workspace run. The employee's instructions guide its work; they never replace your approval or grant access to an app.

## Give it the right access

A model connection powers the employee. An app connection provides access to a particular account. **Tool policy** controls what that employee may use. These are separate choices.

Connect only what the job needs, check the account and resources being shared, and review any required actions. A template cannot automatically send campaigns, update customer records, or make payments. See [Connections and tools](/docs/connections/).

## Keep related work together

Return to an employee's card and open a conversation under **Threads started with this bot**. Continue there for revisions, or launch a new thread for unrelated work.

Multiple employee profiles do not automatically share private conversations or act as an unattended team. Use the sharing controls available in your workspace and check the audience before sharing context.

Next: [Give your first task](/docs/getting-started/) or [review threads and results](/docs/dashboard/).
