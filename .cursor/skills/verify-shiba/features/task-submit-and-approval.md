# Task submit and approval

## Sub-features

- Fill composer (task + repo) and send.
- Approval card appears.
- Reject path: no container starts.

## How to get to it (user POV)

Open /app/, use Task composer. Choose Project, type Task description, optionally Create pull request, Send task. Approvals view or chat card shows Approve/Reject.

## Driving it with Playwright

page.getByLabel('Task composer')
page.getByLabel('Task description')
page.getByLabel(/^Project:/)
page.getByLabel('Search repositories')
page.getByLabel('Create pull request')
page.getByLabel('Send task')
page.getByRole('button', { name: 'Approve' })
page.getByRole('button', { name: 'Reject' })

## Gotchas

- Send stays disabled until task and repo are non-empty.
- wrangler must use --local-upstream localhost or /api is 401.
- Chat Approve is ApprovalCard; stored queue is StoredApprovalCard.
- Baseline (unmodified code) has no review-after-publish copy on the card.
