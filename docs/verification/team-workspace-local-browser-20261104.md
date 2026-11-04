# Team workspace browser acceptance — 2026-11-04

The actual production-built dashboard was served by a disposable local Shiba Worker with real local Durable Objects, D1 and R2 bindings. Chromium used independent cookie contexts. No HTTP responses were mocked. This is local runtime evidence, not deployed Cloudflare, Slack or provider acceptance.

The owner signed up through the UI and skipped optional onboarding. Two additional invited-account provenance rows, password hashes and verified-email flags were seeded only in the isolated fixture D1 database while its Worker was stopped. Those accounts then used real Better Auth password sign-in and fresh session checks. No verification email was delivered or tested.

The main run, from 14:21:26 to 14:23:17 UTC, passed 13 specified journeys. Its source hash manifest was unchanged during that run. It exercised invitation acceptance and replay rejection, member/admin changes, two authenticated room members with attributed live presence and bidirectional messages, persisted shared notes and explicit source selection, browser reload, outsider HTTP/socket denial, shared Work list/board/timeline, reviewed recipe import into an archived bot and draft skill, separate restore/review/activation, missing-provider rejection, workspace switching, and membership removal with cached-content clearing. No model, container, external send or production mutation occurred.

The recipe test verifies instruction storage and deliberate activation. It does not prove that a model consumed the activated skill. Provider preflight returned 400 before creating a pending approval or active run. Without an approved executing task, trusted terminal frames, output artifacts, signing, CLI process recovery and external writes remain unverified by this browser run.

Eighteen screenshots cover chat, shared Work and team settings at 390, 768 and 1440 pixels in both themes. Document/body overflow checks passed at every size. Six chat images were recaptured after explicitly selecting the room and waiting for both attributed messages; these later captures show the owner's authorized history after the member was removed. A nineteenth image records the removed member's unavailable workspace. There were no uncaught page errors.

Console/network output was not clean: the invited UI attempted forbidden administrative/setup/computer reads, the operator UI polled unavailable `/api/computers`, and SDK socket buffer/discard warnings occurred around navigation. The server denied those requests. Intentional negative checks also produced 400/401/403/404/405 responses. The JSON records bounded diagnostics; console capture may be truncated at 200 records.

Browser testing found and prompted fixes for an invitation fragment consumed during an uncommitted render and an invited-account landing redirect overriding explicit shared-chat navigation. Both flows passed in the subsequent actual built UI.

An additional local D1 inspection found that human handoffs retained their grouping/task ID but discarded the required instruction text. That finding was sent to the integration lead; a focused retake is pending the correction. The main run's Work assertion covers assignment metadata and views, not delivery of those discarded instructions.

Native invited-account enrollment remains unavailable without a verified sender, email transport and HTTPS auth URL. The browser confirmed its disabled state. Slack, provider execution and deployed current-branch behavior require separate authorized live verification. An existing preview URL was not used for these tests because it did not contain this implementation.

Machine-readable results, source hashes, exact local resource scope, cleanup status and supporting screenshots are supplied with the final evidence bundle. No passwords, cookies, invitation tokens or verification tokens belong in that bundle.
