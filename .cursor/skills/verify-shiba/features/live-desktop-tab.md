# Live desktop workspace tab

## Sub-features

- Task page shows a right-hand workspace with Changes, Desktop, Terminal, and Files tabs (xl breakpoint).
- Desktop tab requests `/api/runs/<id>/workspace/desktop` and embeds the signed viewer when `SHIBA_SANDBOX_DESKTOP=1`.
- Take control / Hand back toggles agent screen input via `/workspace/desktop/control`.

## How to get to it (user POV)

Open **Tasks**, run or select a task, widen the window until the workspace panel appears on the right. Open **Desktop**.

## Driving it with Playwright

Requires `SHIBA_SANDBOX_DESKTOP=1`, `WORKER_HOSTNAME`, and a real container (`wrangler dev` with Docker).

1. Queue and approve a sandbox run.
2. Poll until status is `running`.
3. Navigate to Tasks; assert workspace tabs visible at xl viewport.
4. Click Desktop; screenshot loading or ready state.
5. Optional: with desktop stack healthy, assert iframe/embed present (not a blank error).

## Gotchas

- Without the env flag, Desktop shows disabled — not a failure.
- noVNC/WebSocket proxy is **not** verified in CI without Docker + exposePort.
- Local `default` user id must match token minting (`CF-Access` email or `default`).
