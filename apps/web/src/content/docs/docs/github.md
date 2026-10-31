---
title: GitHub
description: Choose a repository, review changes, and decide whether to open a pull request.
---

Use GitHub as the home for work Shiba produces: code, documents, or test reports. Choose whether Shiba should open a pull request when you submit a task. Review the proposed changes before merging.

<span id="clone-support"></span>

## Choose a repository

Enter the repository's HTTPS GitHub URL and the branch you want to work from. Ask your administrator to grant access if the repository is private. Never put a token or password in the URL.

For your first task, choose a small change in a repository you can check easily. Leave **Create pull request** off while you learn the review flow.

<span id="optional-publishing"></span>

## Open a pull request

1. Turn on **Create pull request** when you want the result sent to GitHub.
2. Review the repository, branch, task, and publishing choice on the approval card.
3. Approve the request, then inspect the returned changes and checks.
4. Open the pull request link when publishing succeeds. Review it in GitHub before merging.

Approving a task does not approve a merge. See [Reviewing pull requests](/docs/review/) for the available review options.

<span id="fidelity-limits"></span>

## Check the result

Review the actual diff, especially file deletions, renamed files, and file permissions. Large results may be incomplete; read any limits or errors before adopting the change.

## Webhooks

Your administrator can connect GitHub events to [automations](/docs/automations/). The event starts the configured workflow; it is not permission to run arbitrary work.

For repository access, publishing limits, and event setup, use [GitHub setup](/docs/github-setup/).
