# Future private reconciliation

This optional workflow uses a separate standing human consent. An ordinary
reviewed comparison does not enable it. It is disabled by default through
`FOUNDER_RECONCILIATION_SCHEDULES_ENABLED=false` and requires migration 0033 plus
the existing native HubSpot and Stripe capture setup. No credentials, accounts,
provider requests, model calls, Slack messages or deployment were created by this
implementation or its fixture tests.

A native workspace manager who owns both sources selects a current completed
comparison, an expiry within 28 days and both source-grant leases, one to eight
reserved results, and a capture-skew limit of one to 1,440 minutes. The server
freezes the original native account, membership version, both source grants and
their contract/executor hashes, verified accounts, fixed selections, mapping,
amount unit and basis, pairing algorithm and implementation digest. The sample
comparison and both captured receipts must still be valid at draft creation and
explicit enablement. Human mutations require the actual native cookie session in
their final database guard; an automation principal cannot enable a grant.

The review deadline is separate from the standing lease. After enablement the
original sample may expire without cancelling future consent; no sample financial
rows are returned by the schedule API. The future grant remains bound to the
original source grants. It continues after the browser session closes until its
cap, expiry, explicit stop or loss of original owner/source authority. Source
read schedules are managed separately.

The cron worker compares only newly completed captures made after the approval
cutoff. It selects the oldest eligible HubSpot capture and the nearest eligible
unused Stripe capture within the chosen skew, with fixed timestamp/ID tie breaks.
Each source query is bounded to 25 candidates; native source call caps are lower.
The same receipt cannot be reused within a standing grant. Missing pairs create
no result or reservation and are checked again in an hour. Successful results are
at least 24 hours apart. A compare-and-set guard prevents a stale missing-pair
check from shortening the deadline written by another successful worker.

The existing source selections stay fixed. In particular, the Stripe
invoice-created interval does not become a rolling period, and the selected
HubSpot deal IDs and property names do not expand. Comparisons make no new
provider reads. Changing source selections requires separately reviewed source
grants and new comparison consent.

An exact pair, result ID and quota reservation are persisted atomically before
computation. A pending database-only computation may resume the same pair after
restart or lost acknowledgement; it cannot relaunch external work or reserve a
second slot. Final result persistence rechecks the standing grant, original
native owner/member, source-grant contracts, exact receipt bytes/hashes, current
implementation pins, expiry and cadence. Stop or revoke prevents later pending
continuation. A stopped grant requires a new reviewed grant to restart.

Results use a separate `frr_` record and explicitly identify the schedule as their
principal and standing consent as their authorization. They are not presented as
individually human-reviewed comparisons. Each result expires within 24 hours and
no later than the standing grant or either source/receipt lease. Reads require a
current original-owner native session and repeat combined session/source/result
proofs before returning bytes, including synchronous expiry checks. List and
reduction endpoints return cleanup metadata rather than private source details.
Revocation remains available when the feature or sources are unavailable.

Report arithmetic remains exact-ID and per-currency integer comparison. Independently
timed bounded captures cannot establish dataset completeness, absence, payments,
revenue, a full ledger or business success. Application revocation is enforced;
stored capture proofs do not independently detect an upstream credential change
that the application has not yet observed. Already delivered copies cannot be
withdrawn. No sharing permission is created by comparison consent. The separate,
default-off [combined-report Slack contract](founder-reconciliation-slack.md)
requires explicit original-owner disclosure and approval by a different configured
native manager for one exact destination and audience.

Local evidence includes actual SQLite statements, concurrent ticks, cutoff/skew
and reuse cases, quota/cadence limits, exact pending recovery, pause/revoke races,
native session deletion, source mutation and bounded D1 parameter counts.
Provider and identity responses are fixtures; real Cloudflare cron, live accounts
and multi-user browser acceptance remain unverified. The source manifest check
invalidates old standing grants when covered execution code changes.
