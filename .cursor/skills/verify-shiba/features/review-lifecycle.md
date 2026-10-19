# review-lifecycle

## Sub-features

- Finding triage (`open` / `resolved` / `irrelevant`) persisted via PATCH and shown in the dashboard.
- Approval-gated merge request (`pr_merge` kind) from the PR card (mock GitHub only in cloud stand-in).
- Incremental re-review policy: new head SHA queues another reviewer round under the original publish approval (API/unit level; full live path needs wrangler + Docker).

## How to get to it (user POV)

1. Complete a task with **Create pull request** and **Read-only review** enabled (or seed a run with `pullUrl` in mock mode).
2. Open the thread: **Review findings** lists severities; change **Triage** on a finding.
3. On the **PR card**, click **Request merge (approval-gated)** and approve the merge card in Approvals.

## Driving it with Playwright

```bash
.cursor/skills/verify-shiba/scripts/drive.mjs --feature review-lifecycle
```

- `getByTestId('review-findings')` and `locator('[data-finding-id]').first().getByLabel(/Triage/)`.
- `getByTestId('pr-merge-request')` after `pr-card` is visible.
- Mock mode: no live GitHub merge; assert HAR contains `pr/merge` POST and triage PATCH.

## Gotchas

- Triage and merge approvals live on the shared orchestrator DO; session-scoped runs still use `threadId = runId`.
- Cloud agents without `SHIBA_TEST_REPO` must use `VERIFY_GITHUB=mock` — label evidence **mock GitHub**.
- Wake-on-CI/review/merge enqueues **new** follow-up approvals (except synchronize re-review, which reuses the publish approval).
