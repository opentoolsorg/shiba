---
title: Review integration reference
description: Review transport, retries, and publishing boundaries for developers integrating with Shiba.
---

For the dashboard workflow, use [Pull request review](/docs/review/). This reference covers the implementation details needed by integration developers.

## Approval and posting

The task's `reviewAfterPublish` flag is included in the approved input. It covers one read-only review after that task opens its pull request. A review of another pull request follows its own approval flow.

The reviewer returns findings without editing repository files. The Worker posts a GitHub review with event `COMMENT`. Medium- and high-severity findings can appear inline; lower-severity findings remain in the review body.

The review body includes `<!-- shiba-review-round:ROUND_ID -->`. Retries use the existing round to avoid duplicate reviews.

## Review transport

These routes belong to the v1 thread transport and its authentication and scope rules:

| Route | Purpose |
| --- | --- |
| `GET /api/v1/threads/:id/pr/review` | Read the review round. |
| `POST /api/v1/threads/:id/pr/review/retry` | Retry a failed review or an unfinished GitHub post. |
| `GET /api/v1/threads/:id/pr/review-loop` | Read review-loop settings. |
| `PATCH /api/v1/threads/:id/pr/review-loop` | Update `enabled` and `autoMerge` settings. |

A retry reruns the reviewer if no postable result exists. If the result is ready but the GitHub post failed, it retries that post. A round already posted is left as-is.

`autoMerge` does not merge a pull request on its own. After a clean posted review, it can queue a separate human merge approval.

## Credentials and verification

The GitHub publishing token stays on the Worker and never enters the container. Tests against a local GitHub stub establish local behavior, not successful publication to GitHub. See [Product status](/docs/product-status/) for current verification limits.

Relevant source is under `apps/backend/src/review/`, `apps/backend/src/v1/pulls.ts`, and `apps/frontend/src/components/ReviewFindings.tsx`. See the [API reference](/docs/api/) for the broader transport boundaries.
