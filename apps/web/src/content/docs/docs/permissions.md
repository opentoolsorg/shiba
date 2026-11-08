---
title: Permissions and roles
description: Understand who can administer Shiba, who can see shared work, and what an AI employee can do.
---

An employee's job title describes its work. Access comes from separate permissions. Calling an employee “Finance lead” does not connect a bank account, and calling it “Workspace admin” does not make it an administrator.

## Know which role you are changing

| Role or scope | What it controls | What it does not imply |
| --- | --- | --- |
| **Deployment operator** | Installation-wide setup, such as provider configuration, computer fleet, and deployment MCP administration. | Permission to skip task or publication approval. |
| **Workspace owner or admin** | Team membership and supported workspace management and grants. | Deployment administration or another person's private credentials. |
| **Room participant** | Access to the collaboration room and the work explicitly shared there. | Access to every private source referenced by that work. |
| **AI employee profile** | Job instructions, selected capabilities, and reusable task defaults. | An unrestricted account or independent authority to act. |
| **MCP client identity** | The tool scopes granted to a particular client token. | Every tool or resource available in the installation. |

An invited account can see some provider information without being allowed to change provider setup. If a control says it needs a deployment operator, becoming a team admin is not a workaround.

## Follow access from account to action

For connected tools, check these layers in order:

1. **Connection:** Is the intended account connected and usable in this scope?
2. **Tool policy:** Is the tool registered and allowed for the workspace, person, access role, and employee?
3. **Resource grant:** Does the permission cover the actual project, channel, document, or other resource?
4. **Action approval:** Does this particular operation need approval, and does the approved request still match?

All applicable layers must allow the action. Adding an employee capability cannot override a narrower workspace policy, client-token scope, or account grant. Shiba rechecks current policy and connection access when a tool is invoked, so a tool seen earlier may no longer be available after a change.

Some supported reads can use explicit standing consent. A read grant does not permit writes. An approval is tied to the relevant employee version, execution context, account, and action arguments; changing the request can require a fresh decision.

## Three different review decisions

- **Approve a run:** allow the specific repository or artifact-workspace task to start.
- **Approve a deliverable:** record that you accept a captured file. This does not execute a revision or share it outside Shiba.
- **Approve publication or an app action:** allow the specific external operation. Pull request publication uses the completed, frozen file snapshot and a separate approval.

A schedule, employee template, skill, shared room, or saved task cannot substitute for one of these decisions. See [Approvals and control](/docs/approval-gates/).

## When access is denied

Read the reason before reconnecting accounts or broadening permissions. Check the selected workspace and employee, the account owner, the required resource, and whether the approval refers to an old version. Ask the person responsible for that layer to make the smallest needed change.

Do not paste credentials into a task or share an operator account to get around a missing permission. For connection setup, use [Connections and tools](/docs/connections/). Installation owners can review the technical boundaries in [Security](/docs/security/).
