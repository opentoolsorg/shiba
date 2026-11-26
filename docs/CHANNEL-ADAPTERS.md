# Chat channel adapters

[`ports/channel`](../apps/backend/src/ports/channel/index.ts) defines the
inbound transport and outbound `ChannelAdapter` contracts. Slack, Discord,
Telegram, Teams and email each register one definition in the
[channel registry](../apps/backend/src/ports/channel/registry.ts).
New channels should implement those contracts and exercise the shared
[contract suite](../apps/backend/src/ports/channel/contract-suite.ts).

## Slack

The orchestrator's threaded posts, outbox retries and approval cards use the
[existing Slack adapter](../apps/backend/src/channels/slack/index.ts). Posts
return the Slack channel and message timestamp, with the original thread ID
when replying. Native fields carry Slack blocks; the Slack adapter also accepts
a persona override. Email approval cards post unthreaded and use the Slack
app's own appearance.

These posts use the configured `SLACK_BOT_TOKEN`. Inbound verification still
requires `SLACK_SIGNING_SECRET`; its absence does not disable outbound posts.
Managed OAuth token lookup and revocation, private command replies, and inbound
routes are unchanged. Do not substitute a global bot token for a managed
installation token.

The orchestrator builds the cards, and the existing Slack interaction handler
parses their approval pointers. Posting a card or verifying a signed delivery
does not authorize an actor to resolve an approval.
