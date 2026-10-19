---
title: Pull request review
description: One approval covers a read-only review that the Worker posts to GitHub.
---

After a task opens a pull request, Shiba can run a reviewer on that pull request and post one GitHub review.

## What you approve

In the task composer, turn on **Create pull request**. **Read-only review after publish** is on by default. The approval card states that a read-only review will run after the pull request opens and that Shiba will post the findings. That flag is part of the frozen input hash. Rejecting the card starts nothing.

The reviewer does not get a second approval. The original approval covers the coding run, the pull request, and one review on that pull request. Webhook reviews of other people's pull requests still wait for their own approval.

## What gets posted

The reviewer must not modify code. It returns findings in the result envelope. The Worker, not the container, calls `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with event `COMMENT`. Findings at `medium` or `high` are inline comments. Lower findings stay in the review body. The body includes `<!-- shiba-review-round:ROUND_ID -->`. A retry reuses that review instead of posting another one.

The thread shows the run, a pull request card (link, state, checks), and one list row per finding.

`GET /api/v1/threads/:id/pr/review` returns the round. The Tasks timeline shows loading, waiting, failed (with retry), and empty-findings states in the **Review findings** panel. `POST /api/v1/threads/:id/pr/review/retry` posts the same round again. `GET /api/v1/threads/:id/pr/review-loop` is unimplemented (always `null`); multi-round loops are not a Phase 1 product surface yet.

## Local proof

`GITHUB_TOKEN` stays on the Worker. A container never receives it. When no test repository is configured, the verify-shiba skill points `GITHUB_API_BASE` at a local stub and labels the evidence **mock GitHub**. That is not a live GitHub success. Dated evidence is in `VERIFICATION.md`.
