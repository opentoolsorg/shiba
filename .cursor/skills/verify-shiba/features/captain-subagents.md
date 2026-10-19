# Captain and parallel subagents (Phase 2b)

## Sub-features

- Captain DO instance `captain:{userId}:{slug}` exposes digest + crew via `GET /api/captains/:slug`.
- R2-backed drive files under `captain/{agentName}/drive/*` via `GET/PUT /api/captains/:slug/drive/:path`.
- Subagent spawn `POST /api/runs/:parentRunId/subagents` with `sandboxMode` `fresh` or `shared`.
- Dashboard `data-testid="subagent-tree"` on the Diff view when runs carry `parentRunId` / `subagentPath`.
- Elevated concurrency requires `SHIBA_ELEVATED_CONCURRENCY=1` and respects optional `SHIBA_DAILY_CONTAINER_BUDGET_USD`.

## How to get to it (user POV)

1. Approve a root task with a non-zero subagent budget (API or future composer field).
2. From the captain thread or API, spawn a child task with fresh or shared sandbox mode.
3. Open Diff & Patch Inspector and confirm the subagent tree lists dotted paths and statuses.

## Driving it with Playwright

```bash
.cursor/skills/verify-shiba/scripts/drive.mjs --feature captain-subagents
```

The journey calls `GET /api/captains/verify-captain` from the page context (authenticated fetch), screenshots the JSON digest, and checks the Diff route for `subagent-tree` when seeded runs exist.

## Gotchas

- Shared sandboxes refuse `publishPullRequest: true` (read-only machine semantics).
- Depth is capped at three; deeper spawns return 400.
- Without a remaining subagent budget on the root run, spawn returns 403 (approval required).
- Live parallel sandboxes still need Docker + wrangler dev; this feature records API/UI evidence only unless a parent run with budget is seeded manually.
