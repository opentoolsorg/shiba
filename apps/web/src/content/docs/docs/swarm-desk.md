---
title: Swarm desk
description: Four lanes over the runs you already have, plus share links and Linear or Sentry paste.
---

The Swarm desk projects existing runs into four lanes. It does not start a separate run system.

| Lane | Runs |
| --- | --- |
| **Backlog** | Pending runs. |
| **In progress** | Running runs. |
| **Needs review** | Completed runs, whether or not they have a pull request. |
| **Archived** | Error, aborted, cancelled, and unknown runs. |

## Modes

Modes describe existing agent roles:

| Mode | Role | Work |
| --- | --- | --- |
| **Captain** | `orchestrator` | Plans and delegates. It does not edit the repository. |
| **Build** | `fixer` | Edits in the sandbox. |
| **Review** | `reviewer` | Reads the diff. |

## Sharing

`POST /api/swarm/share` mints a stateless HMAC share link with a fixed 7-day lifetime. `GET /api/swarm/share/<token>` serves a redacted run view. The token is the capability, so the GET route needs no authentication.

The shared view excludes the diff and other private run data. A summary is capped at 500 characters.

## Intake

`POST /api/swarm/intake` and the desk textarea accept:

- A Linear issue URL.
- A bare Linear key and title, such as `ENG-123: Fix the login`.
- A Sentry issue URL.
- Plain text, used as a task.

`POST /api/swarm/intake` with `webhook: true` normalizes Linear or Sentry webhook JSON into the same intake shape. This does not add a new trigger kind.

## Scope

This slice has no VM snapshots, video, or Linear/Sentry OAuth. Intake is by paste or webhook JSON. Sandbox concurrency remains capped at `max_instances: 5` in `wrangler.jsonc`.

## Capy-compatible REST API

Every `/api/v1/*` route requires the same authenticated Access session as `/api/runs` and targets the caller's own orchestrator. Use `?session=<sessionId>` to select an owned session. Thread creation also accepts `session` in its JSON body.

| Method | Route | Body and response |
| --- | --- | --- |
| GET | `/api/v1/threads` | Returns `{ threads }`. |
| POST | `/api/v1/threads` | Requires `repoUrl`, `task`; accepts `baseBranch`, `publishPullRequest`, `harness`, `codingModel`, `role`, `session`. Returns the queue's `{ ok, approvalId }`. |
| GET | `/api/v1/threads/<id>` | Returns `{ thread }`, or 404. |
| POST | `/api/v1/threads/<id>/message` | Requires non-empty `text`. Queues a follow-up using the stored repository and continuation key; returns `{ ok, approvalId, threadId: id }`. |
| POST | `/api/v1/threads/<id>/interrupt` | Cancels the run and returns `{ thread }`. |
| POST | `/api/v1/threads/<id>/archive` | Archives the run and returns `{ thread }`. |
| GET | `/api/v1/threads/<id>/tasks` | Returns `{ tasks }`: a creation row followed by recorded runtime signals. |
| GET | `/api/v1/reviews` | Returns `{ reviews }` for unarchived runs in Needs review. |
| POST | `/api/v1/reviews` | Requires `repoUrl`, positive integer `pullNumber`; accepts `headSha`. Queues an approval-gated reviewer with publishing disabled and returns `{ ok, approvalId }`. |

Creation and follow-up requests still require human approval of the exact tool input before execution. A queue response identifies an approval, not an executing run. There is at most one active run per thread: messaging a pending or running thread returns 409; a missing thread returns 404. Review requests use `REVIEW_RUN_MODEL` or `opencode-go/gpt-6.1-sol` by default.

Thread statuses are Shiba's real run statuses, without renaming. `costUsd` is `null` when the harness reports no price. Tasks expose signal `kind` as their `name`. Archiving never cancels a run or changes its status, including when it is pending or running. Explicitly archived runs appear in Archived before status-based lane selection. Mark resolved performs this archive operation.
