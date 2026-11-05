# Bounded founder scheduled reads

Scheduled reads use a separate standing grant. Installing a founder template,
saving a manual action plan, approving one app action or generating a private
report does not authorize a schedule. The dashboard exposes this flow only in
an explicitly selected team workspace; route authority remains server-owned.

The initial UI offers only operations returned by the audited read gateway:
fixed Figma file metadata and file comments, GitHub pull-request listing and a fixed bounded
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

Reports cite bounded captured responses and record the selected source revision, fixed arguments, capture time, bytes, request and result digests, and reviewed runtime and executor pins. Figma comment captures project comment IDs, text, timestamps and parent references; other provider fields are dropped and known credentials redacted before persistence. Dataset completeness is unknown and
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

## Current provider boundaries

The weekly ads recipe names both Meta and Google Ads. Pinned OpenConnector `d89dc9f24f5a057bb500272d7dbf333837c77c68` declares Meta as API-key authenticated and Google Ads as OAuth with an additional secret developer token and explicit customer ID. Its generic GAQL operation accepts arbitrary query text and is not exposed here; the separate fixed Google Ads operation below is audited. Stripe is API-key authenticated in that pinned provider, while the OpenConnector lane admits only encrypted OAuth credentials. A separate default-off [Stripe lane](founder-stripe-read-design.md) uses an explicitly reviewed restricted-key contract. HubSpot–Stripe reconciliation remains unavailable; it cannot be inferred from account badges or fixture data. Supporting these sources needs a separately reviewed secret boundary, exact resource selectors, fixed queries and response contracts, and explicit original-owner consent.

Figma's [comments endpoint](https://developers.figma.com/docs/rest-api/comments-endpoints/) requires `file_comments:read`; an installed OAuth account may lack this scope or file access. Its exact file key is reviewed as a distinct operation and does not extend a metadata-only grant. The bounded capture is not a complete comment history, and no ticket is created. The source additions change the gateway build and manifest: an operator must review and pin a new deployed version before use. Existing grants retain their frozen contract and fail closed when runtime pins change; they do not acquire the new operation.

The separately scoped Google Ads operation, `googleads.campaign_daily_metrics`, uses a fixed v25 `GoogleAdsService.Search` query for campaign ID/name, date, impressions, clicks and cost micros. The reviewed arguments name a ten-digit customer and login customer and an inclusive date window of at most 30 days; the query returns at most 25 rows in one request, and dataset completeness remains unknown. The input never accepts GAQL, arbitrary filters, URLs, headers or credentials. The developer token comes only from the selected encrypted OAuth connection's `oauthClientSecretExtra` in the sibling Worker. It is not returned to Shiba, the browser, container, or receipts. Google documents [call headers and manager-account access](https://developers.google.com/google-ads/api/docs/concepts/call-structure), [Search query syntax](https://developers.google.com/google-ads/api/docs/query/structure), and [date-segmented metrics](https://developers.google.com/google-ads/api/docs/reporting/segmentation). The pinned upstream source declares the v25 endpoint and secretExtra field.

Google Ads requires an independent Worker-only `OPEN_CONNECTOR_SCOPED_READ_RUNTIME_TOKENS` secret containing a JSON array of objects with exactly `workspaceId`, `connectionId`, `operationId` and `token`. The operation must be `googleads.campaign_daily_metrics`; use the native connection ID and a separately issued runtime token limited to that upstream connection and operation. At most 64 entries and 32768 UTF-8 bytes are accepted; duplicate entries for a selected workspace and connection fail closed. Invalid entries for another source cannot select or disable this one. Never place this secret in browser state, logs or a request body. The prior `OPEN_CONNECTOR_READ_RUNTIME_TOKEN` continues to serve non-Google operations, with no fallback between the two lanes. An HMAC fingerprint of the exact key and source scope is frozen in new Ads grants and checked at attestation, enable and dispatch; rotation or a missing pin requires a new review. Google Ads requires a dedicated read runtime token scoped to this exact operation and one selected connection; an Ads grant contains only that one read step. It also requires an independently provisioned high-entropy `SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY` (at least 43 URL-safe characters generated from a cryptographically random key) in the sibling Worker. Preparation uses a one-purpose parent-signed nonce and current native source guard; the sibling consumes it before reading encrypted connection metadata and returns only an HMAC fingerprint binding the OAuth source, revision and developer token after a final parent proof. Human review freezes the fingerprint and exact query inputs; dispatch checks the current source fingerprint again before the existing one-use dispatch permit. A missing token, fingerprint key, changed source, denied runtime scope or revoked native authority fails closed. Rotating the fingerprint key invalidates existing Ads approvals. The secret is never included in the reviewed contract. Operator configuration and a separately reviewed manifest/version pin are required; no Google Ads account or provider call has been tested here. The changed manifest requires a new operator pin; existing grants pinned to the prior manifest fail closed and require fresh review. Existing operations do not gain access to this operation. Meta Ads is not implemented by this operation.

HubSpot invoice reconciliation remains unavailable. Its remote MCP OAuth audience, exact account-specific tool schema and supported native source adapter must be established before capture. Existing REST OAuth accounts and synthetic receipt comparisons do not establish this capability. No HubSpot call is implemented or made.
