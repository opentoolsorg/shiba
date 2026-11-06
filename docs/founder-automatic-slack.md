# Standing Slack delivery for scheduled evidence

Scheduled app reads and Slack delivery have separate consent. This optional path sends only future **completed** reports from one exact, currently authorized automatic-read grant. It never approves reads, starts a model, or grants connector access.

The deployment must explicitly enable automatic reads, managed Slack installations, and the room outbox. A native owner must own every selected app source and the managed Slack installation. An existing authorized room/thread link and current configured room audience are required. Legacy deployment bot tokens cannot authorize automatic delivery.

The owner prepares a bounded contract from a current completed sample, chooses one linked destination, one to ten sends, and an explicit expiry no later than 28 days or the read-grant/token expiry. Existing grants keep their original expiry. The review shows the exact read contract, version and digest, installation generation, room audience, full sample, render policy, byte limit and expiry. The owner separately acknowledges that **all current and future people with access to the selected Slack channel/thread can read delivered content**. The room member list is not a Slack channel membership list. Slack messages already delivered cannot be withdrawn by revoking the Shiba grant.

A different configured native human manager who currently belongs to the room must approve the disclosed contract within its original 15-minute review window. The scheduler is a distinct machine principal; it does not impersonate this human. A report's scheduled time must be strictly later than the human approval. Historical reports are never caught up or sent under a new grant.

The chosen delivery lease must cover both a future scheduled occurrence and its completion. Weekly schedules can use a separately reviewed longer lease; the seven-occurrence/read-call budgets do not increase. A rotating Slack token's shorter expiry can prevent a weekly lease, and a token refresh/generation change requires fresh review. No permission is silently extended. A new lease does not resend an earlier report.

The sample must remain complete, exact and authorized through preparation, disclosure and approval. Its private text still expires within 24 hours. After activation it is an illustration and audit hash, not continuing authorization: an expired sample is hidden while the active future-family controls remain available. Every new report independently passes the current source and private-report proof before delivery.

New drafts freeze `complete-qualified-compact-json.v2`: the renderer retains every field and result from the complete canonical stored JSON, compacts whitespace, adds the completeness qualifications, and escapes Slack control markup. The owner and separate approver see the exact policy and illustrative content before deciding. Existing `complete-qualified-markdown.v1` grants continue to render the complete stored Markdown with their original policy; they are never silently upgraded. The complete private report remains unchanged. The entire rendered message must fit 3,500 UTF-8 bytes. Oversized or unreviewable content blocks the grant; there is no truncation, field selection, model summary, inferred metric or business-success claim.

Each attempt atomically consumes a send count and creates a durable per-occurrence/destination latch before bot verification or delivery. Counts are never automatically returned. A final combined D1 proof rechecks the exact read source, report bytes, native identities, human approval, room audience/link, installation generation and deadlines after all asynchronous preparation. One fixed HTTPS Slack request follows a synchronous time/configuration check. There are no automatic retries. Unknown outcomes and expired orphaned send leases block that destination across replacement grants, installation IDs and token generations; an operator must inspect them. A known rejection or preflight failure also stops the standing grant.

Pausing or revoking is explicit. There is no resume operation; a fresh contract and separate review are required. Changes to room membership, workspace membership or destination permanently invalidate pending/active grants, preventing removal and re-addition from reviving authority. Source/profile/skill/read-grant/installation revisions fail closed. Current source, native identity, audience, installation and report expiry also govern access to sample and delivery text; stored output is not permanent shared memory.

In the dashboard, open an explicitly selected completed scheduled-read report, then open its separate future Slack delivery panel. An owner prepares and discloses the exact family; the different configured approver uses the disclosed-grant entry to review it. Opening a report or delivery panel never authorizes a send.

The native API uses `X-Shiba-Workspace` and same-origin JSON mutations:

- `GET /api/founder-skills/:library/automatic-slack`
- `POST .../automatic-slack/preview`
- `POST .../automatic-slack/grants/:id/disclose`
- `POST .../automatic-slack/grants/:id/approve`
- `POST .../automatic-slack/grants/:id/pause`
- `POST .../automatic-slack/grants/:id/revoke`

Verification uses actual SQLite transactions, canonical automatic-read report/source guards, and a fake Slack transport. It covers separate human consent, future-only selection, source/identity/audience/installation revocation, concurrency, finite counts, final-await expiry, private-output fences and uncertain receipts. This is local fixture evidence. No real Slack installation, production delivery, live provider call, credential creation or account changes were performed for these tests. Live acceptance still requires an authorized configured installation and explicit human grant/approval in the target environment.
