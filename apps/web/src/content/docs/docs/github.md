---
title: GitHub
description: Work in an existing repository, review changes, and choose whether to publish a pull request.
---

Use GitHub when an AI employee needs an existing codebase or your team keeps documents in a repository. For standalone drafts without GitHub, choose an [artifact workspace](/docs/dashboard/#choose-the-kind-of-work) instead.

<span id="clone-support"></span>

## Choose a repository

Select **Repository task**, enter the repository's HTTPS GitHub URL, and choose the branch to work from. Ask your administrator to configure access for a private repository. Never put a password or token in the URL.

Start with a small change you can inspect easily. Leave **Create pull request** off while you learn the workflow.

<span id="optional-publishing"></span>

## Open a pull request

1. Turn on **Create pull request** when you want the completed changes proposed on GitHub.
2. Review and approve the initial task request. This starts the work, not publication.
3. Inspect the returned files, diff, and checks.
4. Review the separate publication approval for the completed changes.
5. After approving publication, open the returned pull request link and verify the result.

Neither running the task nor publishing the pull request approves a merge. See [Pull request review](/docs/review/) for review options.

<span id="fidelity-limits"></span>

## Check the result

Read the actual diff, especially deletions, renamed files, and file permissions. Large results may be incomplete; check any limits or errors before adopting the work.

## Request work from events

Your administrator can connect GitHub events to [automations](/docs/automations/). An event requests the configured workflow; it is not permission to run arbitrary work.

For repository access, publishing limits, and event setup, see [GitHub setup](/docs/github-setup/).
