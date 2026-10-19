# Review findings

## Sub-features

- Chained reviewer run after publish.
- One COMMENT review with round id.
- Findings list matches posted comments.

## How to get to it (user POV)

After a publish+review run settles, stay on the thread. Findings list is data-testid=review-findings.

## Driving it with Playwright

getByTestId('review-findings') and li[data-finding-id]. Compare GET /pr/review to mock/live review body.

## Gotchas

- Baseline returns null/501 for review-loop and has no findings UI.
- Mock evidence is not live success.
