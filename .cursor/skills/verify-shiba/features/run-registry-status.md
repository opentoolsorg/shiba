# Run registry status

## Sub-features

- Runs view lists records.
- Status chips and counts.
- Selected run used by PR/findings.

## How to get to it (user POV)

Open Runs from the nav rail (or ?tab=runs).

## Driving it with Playwright

Navigate to Runs. Screenshot filters and chips. GET /api/runs for JSON read-back.

## Gotchas

- Without the worker, /api/* is HTML and the registry errors.
- Seeded DO rows can exercise status without a sandbox.
