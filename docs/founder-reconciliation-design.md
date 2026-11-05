# Private receipt-bound reconciliation

This one-shot composition compares two already-captured reports: one explicitly selected, completed native HubSpot selected-deal receipt and one completed Stripe invoice receipt. The original native owner must retain both exact source grants and their original membership. Creating a draft makes no provider, model, Slack or write request. The owner separately reviews and consents to the frozen receipt references and mapping before composing. Every route requires the original native owner’s real cookie session. Create and compose bind the exact current session and both source authorities in their atomic SQL writes; private reads combine those checks with immutable receipt/report hashes, exact grant and executor pins, and synchronous expiry checks after the final database proof. Revocation removes the stored comparison and requires no continuing source access.

The mapping identifies three distinct selected HubSpot internal properties: Stripe invoice ID, paid amount, and currency. The creator explicitly attests that the CRM amount represents the Stripe invoice's `amount_paid` and selects either major decimal units or integer minor units. This attestation does not prove semantic equivalence; a HubSpot deal's ordinary amount should not be assumed to represent invoice payments. Only exact `in_...` IDs are compared. Names, email, fuzzy matching, inferred payment periods, foreign exchange and rounding are never used.

Only USD, EUR and GBP at two decimal places and JPY at zero decimal places are comparable. More fractional digits than the permitted currency exponent are rejected, including extra trailing zeros. Decimal values are parsed to arbitrary-precision integers without binary floating-point conversion. Unsupported currencies, currency mismatch, invalid/missing money and excess precision are non-comparable. Per-currency totals include only uniquely matched comparable captured rows; they do not sum across currencies.

Duplicate invoice IDs on either captured side are ambiguous and never summed. Missing, invalid and unmatched IDs are separately reported; `unmatched_in_capture` means only that a matching row was not present in the other captured subset. A selected deal not returned by HubSpot is `uncaptured_deal`, not an assertion of absence. Stripe invoice status and creation time are shown for context. Source capture timestamps, selected IDs and interval, Stripe `has_more`, account/revision, report/receipt hashes, manifest and executor pins are attached. Captures are independently timed, bounded, and may not be synchronized. Dataset completeness is unknown and business success unverified; there is no complete-ledger, revenue, MRR or churn claim.

The HubSpot source is a separate default-off native lane using a user-supplied, appropriate static single-account or existing private-app token. It does not reuse OpenConnector or MCP OAuth. A selected portal is verified against the account-details response, then a fixed batch read requests only explicitly selected deal IDs and three reviewed properties. No arbitrary REST or MCP proxy is authorized. Until both exact current authorized receipts exist, the composer fails closed. Native HubSpot source provenance uses `native-hubspot.v1` and an application source digest; these are not cloud-deployment attestation. The tests use synthetic receipts and do not establish live HubSpot or Stripe compatibility. No standing composition or Slack-delivery grant is created by this feature. Current local grant checks do not prove that a provider has not independently revoked access since capture.

Future unattended private comparisons require the separate [standing reconciliation contract](founder-reconciliation-schedules.md). This one-shot approval does not enable or widen that authority.

## Explicit rolling-period review

The native private dashboard can select a completed, still-authorized comparison,
then review a metric, a UTC Unix-second exclusive endpoint, and 1–28 fixed
24-hour days before requesting a rolling view. This is an invoice-creation
window, inclusive at the start and exclusive at the end, not a local calendar
day or a payment-date ledger. The source account's timezone is evidence only;
it does not change the UTC interval, including across daylight-saving changes.
The endpoint must remain within the captured Stripe interval and cannot be in
the future. Source captures from the future are refused. Changing the selection
requires fresh UI review; a failed request never retries automatically.

`invoice-paid-snapshot` sums only uniquely matched comparable captured amounts,
using integer strings and separate currencies. Dated non-comparable and unmatched
rows remain visible; undated and duplicate-key rows stay unassigned rather than
being silently excluded as outside the period. The output includes selected and
unassigned row status counts, explicit partial-input reasons, capture ages and
skew, mapping, exact receipt/report/executor provenance, and the reviewed digest.
Capture ages describe evaluation time, so replaying the same request preserves
rows/totals but may change ages. Source expiry remains an authorization boundary:
the native route rechecks the exact source, owner, membership and session proof
after composition and withholds all output if any authority changed. It does
not refresh a source or create standing or Slack-sharing consent.

`mrr` and `churn` are selectable definition requests, not aliases for invoice
totals. Both return **unavailable**, no metric totals, and explicit missing-data
reasons. MRR requires captured subscription lifecycle snapshots, recurring
price/quantity/interval/effective dates, and a reviewed normalization contract.
Churn requires lifecycle events, a period-start cohort, cancellation/reactivation
effective dates, and a reviewed denominator/event contract. Those inputs and
contracts do not exist in this capture lane; provider fetching or inferred
subscription metrics must not be added to composition. Completeness remains
unknown and business success unverified for every selection.
