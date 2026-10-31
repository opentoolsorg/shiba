---
title: Linear
description: Turn a delegated Linear issue into a task you can review in Shiba.
---

When your installation has Linear connected, a delegated issue or a mention can send its context to Shiba. You still review the proposed task before repository work starts.

## Before you start

Ask your administrator whether Linear is enabled for your workspace and which repository it uses. Linear support is still being validated; confirm the connection with a small test issue before relying on it.

## Delegate an issue

1. Write a clear issue with the expected result and useful context.
2. Delegate it to the configured Shiba agent or mention that agent in the issue.
3. Open Shiba and review any approval request for the task.
4. Check the repository, proposed work, and publishing choice before approving.

Delegating an issue is not approval to execute it. If no task appears, ask your administrator to check the connection and repository setting.

## Review the result

Inspect the returned files, diff, and checks in Shiba. Open a pull request when one was requested and successfully published. This version does not post final results or pull request links back to Linear.

## Set up the connection

Application credentials and event delivery are managed by your administrator. See [Linear setup](/docs/linear-setup/) for the configuration and current limits.

Continue with [Approvals](/docs/approval-gates/) or [Threads and results](/docs/dashboard/).
