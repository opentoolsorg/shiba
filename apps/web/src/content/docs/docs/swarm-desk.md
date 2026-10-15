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
