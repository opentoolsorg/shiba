# Native-owned Slack workspace installations

This optional first slice stores and routes multiple **bot workspace**
installations. It does not link a Slack author to a native person, payer,
private transcript or app grant. New-tenant coworker execution therefore stays
unavailable. Signed slash/interactivity requests receive an actionable response;
mentions are acknowledged without model calls, borrowed context or automatic
outbound messages. Existing explicit one-shot report sharing can use an owned,
generation-bound installation.

No real installation, OAuth exchange, Slack send, account or credential was
created while implementing this path. Local acceptance uses native SQLite,
native identity fixtures and fake Slack HTTP.

## Operator prerequisites

`SLACK_INSTALLATIONS_ENABLED` defaults to false. Enabling the feature also needs
the exact Slack app ID, client ID, existing app signing secret, a canonical HTTPS
`SLACK_OAUTH_REDIRECT_URI` ending in `/api/slack/installations/callback`, and a
Worker-only `SLACK_INSTALLATION_KEYRING`. The keyring is JSON with
`activeKeyId` and one to three `keys` mapping explicit short IDs to 32-byte hex
keys. No key is generated, copied to a container, or returned by a route.

`SLACK_OAUTH_PKCE_ENABLED=true` attests that the operator already enabled PKCE
for the Slack app. This code does not alter app settings. Slack documents that
enabling PKCE makes an app a public client and cannot be undone without Slack
support. HTTPS web callbacks can request bot scopes; PKCE desktop/custom-scheme
or localhost redirects cannot. PKCE uses S256 with URL-safe base64 and a
`code_verifier`, omitting `client_secret` during exchange; refresh does not send
PKCE parameters. PKCE-enabled refresh tokens expire after 30 days. See the
[official PKCE guide](https://docs.slack.dev/authentication/using-pkce/).

`SLACK_OAUTH_QUERY_REDACTION_VERIFIED=true` is an operator attestation, not a
measurement performed by this code. OAuth necessarily returns its temporary
code and state in the callback query. Configure and verify invocation/access
log query redaction before a live test. This includes the previously observed
preview logging gap. The callback serves no assets, uses `no-store` and
`no-referrer`, and redirects immediately to a clean dashboard URL. It never
returns a code, verifier or token. Slack's temporary code expires after ten
minutes; see the [OAuth guide](https://docs.slack.dev/authentication/installing-with-oauth/).

## Human installation and activation

Only a currently verified native **workspace owner** can begin. Bearer keys,
unverified accounts, workspace admin/member roles and Slack display names do
not substitute for that native authority. The explicit begin request reviews
the exact known bot scopes; `chat:write` is required. No user, enterprise-admin,
search, native-agent or wildcard scope is requested implicitly.

The one-use state is stored only as SHA-256. The PKCE verifier is encrypted with
the original workspace, native UUID, pending intent ID and purpose. The intent
also pins native membership revision, scopes, callback/client/app configuration,
stable request UUID and a ten-minute deadline. A duplicate begin request cannot
recover its state or mint a renewed OAuth launch. At most three starts per
owner per ten minutes, 128 live pending exchanges and 16 stored installations
are admitted. Expired pending verifiers are cleared without renewing consent.

Callback requires the original native owner session and exact current
provenance before claiming state. A fixed Slack token endpoint exchanges the
code once. The response must be a non-enterprise bot-workspace installation of
the configured app, with exactly the reviewed scopes and no user token. A fresh
`auth.test` must match the team and bot user; the bot ID and actual Slack
installer user ID are retained as provenance. The Slack installer ID is **not**
a native identity or permission grant.

One `(app ID, team ID)` is owned by one original native UUID and one Shiba
workspace. Another owner/workspace cannot overwrite that association; transfers
are unavailable. Reinstallation by the same owner increments generation,
version and token revision. Old sources, approvals and send snapshots cannot
follow the new token automatically. A separately reviewed exact metadata digest
must activate the pending installation before use. No callback auto-approves.

OAuth can have completed in Slack even if a local callback is rejected or its
outcome is uncertain. The code does not automatically uninstall or revoke that
external app, which could affect somebody else's existing installation. Inspect
the outcome and start a fresh explicit flow when appropriate.

## Secrets, refresh and revocation

AES-GCM uses the repository's existing credential primitive with a separate
Slack purpose and authenticated workspace/install/native-owner/app/team/bot/
generation/token-revision scope. Stored credentials and PKCE verifiers remain
encrypted. Ciphertext is excluded from every public DTO. The private Worker
resolver checks the exact current native owner and installation before and
after decrypting. It never falls back to the deployment bot token.

New writes use the active key ID. Retaining a bounded old key permits reads
during explicit rotation; refresh/reinstallation reseals using the active key.
Removing a needed old key fails closed until reauthorization. There is no
implicit fallback to model keys or another installation.

Refresh requires a separate current owner's exact review. An atomic claim
permits one exchange. A successful refresh keeps the identity/scopes fixed and
increments token revision/version. A missing, expired or lost refresh result
becomes unavailable/unknown; it is never retried or leased again automatically.
Local **Disable** revokes Shiba's use and wipes stored ciphertext. It does not
claim to uninstall the Slack app remotely.

All callback signatures use the raw bounded body and timestamp before parsing
or tenant lookup. App/team then resolves only to the exact active installation.
Signed `app_uninstalled` and matching bot `tokens_revoked` notices durably revoke
and increment generation; pending flows predating the notice cannot activate.
Duplicate events do not repeat revocation. Event order is not guaranteed, so a
late genuine notice can conservatively disable a newer installation rather
than revive authority. Slack's revoked token lists contain user IDs, not token
strings: [uninstall](https://docs.slack.dev/reference/events/app_uninstalled/),
[token revocation](https://docs.slack.dev/reference/events/tokens_revoked/),
[signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

Disabling this feature does not erase installation history or permit managed
teams to borrow legacy credentials. Verified uninstall and bot-revocation
notices still disable known installations while the feature is off. The bounded
event journal is trimmed only after revocation is recorded, so a full journal
cannot suppress a security notice.

## Report delivery and legacy compatibility

A managed report's immutable destination includes its nonsecret installation
ID, native owner, app/team/bot, generation, version and token revision. The
report creator must also be that installation's original native owner. Allowed
managed channels come only from the existing strict `SLACK_CANVAS_OWNERS`
team/channel/owner/viewer policy. This does not discover new channels or enumerate
their recipients. Explicit consent to all Slack channel/thread readers and a
separate configured native human approval remain necessary. The final report,
native, audience, link, approval and installation fence follows token checking
and all other asynchronous reads immediately before sending.

When the new feature is off, untouched legacy operation remains available.
An intent carrying a managed snapshot can never fall back to legacy, even if
the feature is later disabled. New intents for a previously managed or revoked
team also cannot use legacy credentials. In multi-install mode, legacy fallthrough needs
explicit `SLACK_LEGACY_MODE_ENABLED`, exact legacy app/team, and no managed
installation or revocation history for that team. Legacy report deliveries also
retain `SLACK_APPROVALS_CHANNEL`. Unknown teams never borrow operator tokens.

The workspace Integrations panel reads status without starting OAuth. A verified
native owner explicitly reviews scopes, prepares authorization, and separately
opens Slack. After returning, refresh status and review the exact team, app,
bot, scopes, digest and revision before activating. Refresh and Disable each
require another explicit review. Unconfirmed decisions are never retried
automatically; refresh status before deciding what to do next.

## Boundaries and verification

Enterprise/GovSlack, user-token installations, ownership transfers, Slack-to-
native actor/provider/billing linking and general tenant coworker execution are
not supported by this slice. Installation does not enable autonomous founder
delivery; that needs a separate standing human grant. Token metadata and local
activation are not proof of live model execution or installed Slack delivery.

The focused tests in `test/slack-installations.test.ts` and
`test/report-slack.test.ts` exercise native UUID replacement, state/activation
replay, key/scope isolation, tenant ownership, concurrent/uncertain refresh,
owner removal, signature gates, revocation, explicit legacy restrictions,
managed report tokens and post-authentication generation changes. Migration
`0018` includes canonical native-workspace prerequisites and is idempotent on a
fresh database. Live acceptance still requires approved operator configuration,
verified logging privacy and an authorized non-production Slack installation.
