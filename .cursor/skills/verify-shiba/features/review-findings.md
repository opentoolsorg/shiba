# Review findings

## Sub-features

- Chained reviewer run after publish.
- One COMMENT review with round id.
- Findings list matches posted comments.

## How to get to it (user POV)

After a publish+review run settles, stay on the thread. Findings list is data-testid=review-findings.

## Driving it with Playwright

`node scripts/drive.mjs --feature review-findings` then `node scripts/assert-journey.mjs`.

- Records `codingRunId` from `POST /api/runs` → polls run completion and `GET /api/v1/threads/:id/pr/review`
- Reads mock PR + review POSTs from the GitHub stub `GET /__shiba/state`
- `getByTestId('review-findings')` when the UI catches up (assertions do not rely on the 4s wait)

## Gotchas

- Baseline returns null/501 for review-loop and has no findings UI.
- Mock evidence is not live success.
