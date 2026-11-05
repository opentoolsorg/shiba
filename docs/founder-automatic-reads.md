# Bounded founder scheduled reads

Scheduled reads use a separate standing grant. Installing a founder template,
saving a manual action plan, approving one app action or generating a private
report does not authorize a schedule. The dashboard exposes this flow only in
an explicitly selected team workspace; route authority remains server-owned.

The initial UI offers only operations returned by the audited read gateway:
fixed Figma file metadata, GitHub pull-request listing and a fixed bounded
Linear team-issue query. Users cannot provide a URL, GraphQL document, arbitrary
filter, executable code or another operation. Generic connector catalog
metadata, including an advisory read classification, is not standing authority.
An operator must enable and explicitly trust the exact gateway version and manifest before
the server reports this flow available. Missing setup has no generic app,
deployment-account, credential or model fallback.

The parent feature flag is `FOUNDER_AUTOMATIC_READS_ENABLED='true'` and defaults
off. It requires the trusted `OPEN_CONNECTOR_READ_GATEWAY` service binding,
`OPEN_CONNECTOR_READ_VERSION_ID` and `OPEN_CONNECTOR_READ_MANIFEST_SHA256` pins.
These are operator trust pins, not cryptographic source attestation.
There is no public HTTPS fallback. A separate `OPEN_CONNECTOR_READ_RUNTIME_TOKEN`
is required: a stored, revocable sibling runtime key restricted to the exact
audited read operation IDs and exact source connection IDs. It remains Worker-only
and is sent only through the trusted read binding. There is no fallback to
`OPEN_CONNECTOR_RUNTIME_TOKEN`; that existing key keeps its current manual-action
role unchanged. Preparing this code does not create either credential. An operator
must separately approve creating and storing the restricted key before live setup. The internal HMAC signing key stays exclusively in the parent
Worker and is never forwarded to the sibling or browser. The sibling requires its
feature policy, platform version metadata, encrypted OAuth storage and a
`SHIBA_AUTOMATIC_AUTHORITY` reverse binding. Missing or expired OAuth fails
closed; this lane does not silently refresh it or adopt another identity.

## Explicit setup and review

1. Open **Configure bounded scheduled reads** for a founder template.
2. Choose the current employee. The server identifies the creator's current
   owned reviewed skill and eligible source accounts; nothing is selected by
   default.
3. Add each exact account, audited operation and complete fixed argument object.
   Review the operation schema and executor hash. Do not paste credentials.
4. Enter the cadence, local time, IANA timezone, absolute expiry and every call,
   occurrence and byte limit. Saving creates a draft only.
5. Review the complete frozen contract: account revisions, arguments, employee
   and skill versions, recipe, operator-pinned runtime, scheduler identity and limits.
6. Separately consent to these scheduled reads without per-occurrence approval
   and to provider quota use or charges. Only then enable the exact grant.

A newly reviewed grant may explicitly choose an expiry up to 28 days, with seven
occurrences, eight read steps, 56 total
provider calls and one page per step. Existing grants keep their original absolute
expiry; there is no automatic extension or default duration. Each step is limited to five seconds and
each occurrence to 60 seconds. The user also selects captured-byte budgets,
bounded by the server contract. These are application limits, not a provider
invoice cap. No model, coding agent, connected-app write or Slack send is
authorized. An uncertain outcome does not release reserved capacity or grant a
blind retry.

Capacity is reserved atomically before provider calls: at most 458,752 captured
bytes over the grant, 32 KiB per step and 64 KiB per occurrence. A missed due
time more than 15 minutes old is not caught up automatically. An unknown outcome
or expired running lease blocks the grant. An acknowledgment lost after a
durably completed receipt does not authorize a second provider read. Private
report retention is at most 24 hours and also bounded by the grant expiry and
current source authority.

Pause and revoke reduce authority without asking for new read consent. Resume
requires a new explicit review of the exact current contract and quota consent.
Cleanup can use a metadata-only grant pointer when current source access no
longer permits exposing its arguments. Pausing or revoking cannot prove an
already dispatched provider request stopped or was not billed.

## Private evidence and navigation

Occurrences have a distinct scheduler principal. The UI does not fabricate a
human approval or Execute button for them. It exposes the server's completion,
partial, failed, unknown or blocked state and never automatically retries one.

Reports cite bounded captured responses. Dataset completeness is unknown and
business success is unverified. An empty page or transport completion does not
establish business coverage. No MRR, churn, reconciliation, financial totals or
company-level conclusion is computed or invented.

Current authorized creators may read a report and explicitly download its exact
Markdown or JSON bytes through an authenticated private route. The browser
verifies the shared report hash and download bytes before creating a local
file. This grants no external sharing or Slack permission; local copies cannot
be retracted. Report hashes bind the format, occurrence ID, grant ID/version,
absolute expiry and exact rendered Markdown and JSON bytes.

The panel refreshes source and runtime state on focus and while visible and
idle, clears protected content on access failure or version changes, and hides
locally expired contracts/reports. Responses from a previous workspace cannot
paint private report content or trigger a local download in the new workspace.

## Verification and remaining live prerequisites

The [isolated Chromium drill](verification/founder-automatic-browser-20261105.json)
passed 14 assertions with native browser fetch, shared parsers, an exact private
download, separate consent, pause/resume review, unknown-outcome handling,
late-workspace rejection and revoked-source cache removal. It records frozen
source hashes and expected injected HTTP failures. Screenshots cover
[desktop dark](verification/founder-automatic-browser-20261105-desktop-dark.png),
[390px light](verification/founder-automatic-browser-20261105-390-light.png) and
[320px light](verification/founder-automatic-browser-20261105-320-light.png).

Every API response and occurrence in that drill is synthetic. It does not
exercise native identity, Worker/D1 authorization, cron, deployed version and
manifest trust pins, a provider business read or an actual standing grant. Those need
the exact deployed revision, an authorized native creator, current eligible
source grants, an operator-reviewed gateway version/manifest pin and explicit permission for
the bounded provider calls. No credentials, account, live schedule, provider
read, model call or Slack send is created by the frontend tests or browser drill.
