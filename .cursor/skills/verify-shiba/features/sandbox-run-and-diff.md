# Sandbox run and diff

## Sub-features

- Approve starts one sandbox.
- Run leaves pending/running.
- Diff view can show captured diff when present.

## How to get to it (user POV)

Approve a queued run. Watch Tasks/Runs. Open Diff to inspect the selected run.

## Driving it with Playwright

After Approve, poll /api/runs. Open Runs or Diff. Screenshot status and any diff. Record docker ps before/after.

## Gotchas

- Docker is required for a real container.
- --enable-containers=false skips execution.
- Reject must keep docker ps diff empty.
