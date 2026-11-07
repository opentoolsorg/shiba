---
title: Product status
description: Understand what is in Shiba, what depends on your installation, and what still needs verification.
---

Shiba is under active development. These guides describe the current source, but your workspace may run a different revision or have fewer services configured. Start with a small task and check the result before relying on it.

<span id="in-the-tree"></span>

## What the product supports in source

- Reusable AI employee profiles, role templates, and task threads.
- Repository tasks and artifact workspaces for files without GitHub.
- Employee work using supplied context and explicitly granted app tools.
- Human approvals for workspace execution and separate pull request publication.
- Reviewable deliverables, reported checks, and follow-up conversations.
- Account- and workspace-scoped skills, with explicit review and activation for run-attached versions.
- Configured chat channels, app connections, MCP tools, and recurring task requests.

Each path has its own requirements. Workspace execution needs a working model connection and runtime. App work needs the right account and employee grants. A repository is required only when the chosen task uses one.

<span id="not-live-verified"></span>

## What a catalog does not promise

A listed app or MCP preset is not a connected account. A role or skill template is not permission to use a tool. “Ready” provider setup does not establish a successful action against your account.

The OpenConnector operator-account execution path for general API-key/custom credentials remains disabled. Its review-only enrollment and runtime foundations are not an activation path. Other specific supported account flows must be evaluated on their own requirements.

Multiple employee profiles do not establish unattended collaboration, automatic private-context sharing, or permission to act on one another's behalf.

## What to verify in your workspace

Try the exact workflow you plan to use: sign in, select the model and work target, check an approval, and inspect a real result. Test connected channels and vendor actions separately.

Source tests, fixtures, and production builds do not prove live provider compatibility or an end-to-end deployment. The desktop app also should not be treated as a signed public release based on a local build.

For operators, the [readiness checklist](/docs/readiness/) and [implementation status](/docs/implementation-status/) contain dated evidence and limits. The [repository's verification records](https://github.com/opentoolsorg/shiba/tree/main/docs/verification) include newer, feature-specific results. Read each record's date and scope rather than treating an older test count as current production acceptance.

<span id="next"></span>

## Choose your next step

[Give your first task](/docs/getting-started/), [connect tools](/docs/connections/), or find an answer in [Common questions](/docs/troubleshooting/).
