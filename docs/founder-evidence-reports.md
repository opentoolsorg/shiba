# Private founder evidence reports

This workflow organizes 1–8 explicitly selected stored app receipts into cited
Markdown and JSON. It makes no new business query, app action, model call or
sandbox run. Connection authorization metadata is revalidated; that does not
refresh the business data or establish financial coverage.

Every source is a **bounded stored excerpt**. Capture completeness and dataset
completeness are unknown; business success is unverified. Legacy receipt capture
can silently cap strings at 4,000 characters, arrays and objects at 100 entries,
nesting depth, and the complete stored result. An operation recorded as completed
may still contain semantic errors, including GraphQL errors. A retained
`has_more: false`, empty object or null result does not prove completeness or the
absence of business mismatches.

No MRR, churn, financial totals, reconciliation or company-level conclusion is
computed. Empty and partial source evidence remains explicit. The six founder
templates are setup goals, not proof that the underlying integrations can
produce every suggested metric.

## Explicit private flow

1. A verified native workspace manager chooses the current employee and active
   owned reviewed founder skill.
2. Select eligible own completed receipts from recipe-compatible app services.
   Another manager's visible action results do not become your report sources.
3. Choose an absolute expiry within 24 hours. An earlier founder source lease
   shortens that expiry.
4. Preview the exact cited text, JSON, source hashes, limitations and expiry.
5. Explicitly review and create the private immutable record. A stable request
   UUID and expected content hash bind retry reconciliation to the same request.
6. Read, copy or download only after current source authorization is checked.
   Revocation blocks future server reads and downloads; local copies cannot be
   retracted.

The manifest binds native identity, memberships, profile and skill versions,
recipe, source account/grant/decision bindings, original input hashes and exact
stored result bytes. Report hashing excludes record ID and creation time. The
shared helper hashes the UTF-8 bytes of
`JSON.stringify(['shiba.founder-evidence.v1', manifestDigest, expiresAt, markdown, json])`.
The client independently verifies that hash before saving, reading or exporting.

Combined rendered Markdown and JSON are capped at 256 KiB. Oversized evidence is
rejected, never silently truncated to fit. Source expiry or revocation prevents
cached content from being reused. The UI refreshes current permissions while
visible and idle and on focus, and hides locally expired content. A response
from an old actor/workspace/report cannot trigger a new download or clipboard
write in the current scope.

Reports use creator-private D1 records and authenticated, workspace-scoped
downloads. They do not create bearer artifact URLs, signed sharing links or
room messages. The report surface is
`/api/founder-skills/:libraryId/reports`: options, preview, reviewed creation,
private list/read/download and metadata-only revocation.

## Separate one-shot Slack disclosure

Report generation never prepares, discloses, approves or sends a Slack message.
The user must separately open the Slack disclosure panel, select an exact
authorized room-linked thread, and prepare a private draft. The creator must be
the original configured consenter for every selected source connection. This
is a Shiba identity/consent proof, not verification of legal ownership of a
vendor account.

The creator then explicitly authorizes the complete report for **everyone with
access to the selected Slack channel/thread, including people outside the web
room**. The displayed web-room reader IDs are not a complete Slack member list.
A separate authorized human reviews the exact message, report/source/content
hashes, destination and deadline before approving and sending once.

Only a complete neutralized report fitting in one message of at most 3,500 UTF-8
bytes is supported. Larger reports are rejected without splitting or
truncation. Unknown or in-flight delivery outcomes are never blindly retried;
inspect the destination and durable receipt before another action. This is not
a standing or scheduled Slack permission.

## Verification boundary

Focused frontend and backend tests use synthetic identities, SQLite and
intercepted integration responses. They do not prove live account, provider,
Slack installation or deployment behavior. Automatic source collection,
standing read authority, computed founder reports and scheduled Slack delivery
remain separate contracts. Advisory operation-type metadata alone never grants
autonomy.

The [isolated Chromium report](verification/founder-evidence-browser-20261105.json)
records 16 assertions with native fetch, exact download and clipboard bytes,
separate disclosure and send controls, response-loss protection, stale-workspace
download rejection and revoked-source cache removal. It also records frozen
source hashes and the intentional injected network failures. Screenshots cover
[desktop dark](verification/founder-evidence-browser-20261105-desktop-dark.png),
[390px light](verification/founder-evidence-browser-20261105-390-light.png) and
[320px light](verification/founder-evidence-browser-20261105-320-light.png).
All API responses and send effects in this browser drill are synthetic. This
does not establish live Slack delivery, OAuth, native identity, tenant isolation
or deployed provider readiness.
