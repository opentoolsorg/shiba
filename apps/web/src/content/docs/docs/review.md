---
title: Pull request review
description: Review an employee's completed changes, approve publication, and inspect the findings.
---

For repository tasks, Shiba can prepare a pull request and review its changes. You decide whether to publish, accept, or merge the work.

## Request a pull request

1. Choose **Repository task** and select the GitHub repository and branch.
2. Turn on **Create pull request** if you want publication after the work is ready.
3. Select **Read-only review after publish** if you want findings posted after the pull request opens.
4. Read and approve the task request to start the run.

The first approval allows the task to run. It does not authorize pushing the changes or opening the pull request.

## Review the completed changes

When the work is ready, inspect the files, diff, and reported checks. Shiba presents a separate publication approval for the captured changes.

Approve that publication only when the repository, changes, and requested review match your intent. If you want a revision, request it before publishing. Check the returned pull request link to confirm publication succeeded.

The selected post-publication review covers this task's pull request. It does not approve reviews of unrelated pull requests or a merge.

## Read the findings

Find **Review findings** in the thread or read the posted review on GitHub. Findings point to files and lines and explain possible problems.

Check each finding against the change and tests. A review with no findings is not proof that the code is correct. The read-only reviewer reports problems without editing the code.

## If the review fails

Read the error in **Review findings**, address the problem, then choose **Retry review**. If the result is ready but its GitHub post failed, Shiba retries the post rather than repeating the review.

Reviewing does not merge the pull request. Follow your team's merge process and any separate merge approval.

For technical details, see the [review reference](/docs/review-reference/). For files that do not need GitHub, see [Threads and results](/docs/dashboard/).
