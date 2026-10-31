---
title: Pull request review
description: Open a pull request, read the findings, and decide what to do with the changes.
---

Shiba can open a pull request for a task and review the proposed changes. Your team decides whether to accept or merge them.

## Request a review

1. In the task composer, turn on **Create pull request**.
2. Check **Read-only review after publish** if you want Shiba to review the pull request after it opens.
3. Read the approval card. It explains whether the request includes publication and a review.
4. Approve only when that request matches your intent.

That approval covers the task, its pull request, and the review described on the card. The review does not ask for a second approval. Approving one task does not approve reviews of other pull requests.

## Read the findings

Open the task's thread and find **Review findings**. Each finding points to a file and line and explains a possible problem. You can also read the review on GitHub.

Check the finding against the change and the relevant tests. A review with no findings is not a guarantee that the code is correct. The reviewer reports problems; it does not edit the code.

## If the review fails

Read the error in **Review findings**, address the reported problem, then choose **Retry review**. If the review is finished but its GitHub post failed, Shiba retries the post without running the reviewer again.

Reviewing does not merge the pull request. Inspect the diff and checks, then follow your team's usual merge process.

For integration details, see the [review reference](/docs/review-reference/). To review work without publishing it, use [Threads and results](/docs/dashboard/).
