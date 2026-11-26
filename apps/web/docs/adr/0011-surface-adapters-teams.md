# 0011 — Surface adapters; Teams through Bot Connector plus Graph RSC

## Context

Ingress surfaces today: Slack (25 `slack-*.ts` files, ~5.9k LOC, manifest at
`slack-app-manifest.yaml`), Telegram (`apps/backend/src/telegram.ts`), Discord
(`apps/backend/src/discord.ts`), email (`apps/backend/src/email/`), webhooks
(`apps/backend/src/webhooks/`), MCP (`apps/backend/src/mcp-gateway.ts`,
bearer-only) and the
dashboard. The provider seam already exists: `IntegrationProvider`, the action
input policy and the operator-authority model in
`apps/backend/src/integrations/`. OpenConnector is embedded read-only through
`packages/openconnector-read-gateway/` and `infra/openconnector*.mjs`.
`jose` 6.2.12 is already a dependency.

## Options

For Microsoft Teams:

- **(a) Graph-only (change notifications)** — loses: subscriptions need
  renewal and there is no interactive bot experience.
- **(b) Bot Connector** — the conversation channel.
- **(c) (b) plus Graph with resource-specific consent for context** — chosen.

## Decision

(c), behind a `SurfaceAdapter` interface — `verifyInbound`, `toThreadEvents`,
`bindingKey`, `render(event)`, `updateInPlace`, `renderApprovalCard`,
`parseApprovalAction`, `typing` — with two real implementations (Slack and
Teams), which is what justifies the interface. Everything after
`toThreadEvents` is shared: thread DO, employee agent, approvals, outbox.
Teams specifics: a Bot messaging endpoint validating the inbound JWT with
`jose`; Bot Connector REST (thin `fetch` client, no Node-heavy Microsoft SDKs)
for posts, `updateActivity` "working" status and typing; Adaptive Cards with
`Action.Execute` mapping to `ApprovalService.resolve` (ADR-0008); stored
`ConversationReference` in thread bindings for proactive posts; Graph RSC
(`ChannelMessage.Read.Group`) scoped per team for channel context; Entra OIDC
sign-in linking on `tid` + `oid`, never `upn`/email. The buyer registers their
own Entra app and Azure Bot and installs a generated Teams app manifest, just
as Slack works with `slack-app-manifest.yaml`.

## Consequences

- The buyer has to register Azure resources — same self-host shape as Slack.
- Estimated ~2,500 LOC against Slack's ~5,873 (an estimate, not measured; the
  M31 spike re-estimates). Reversal cost: low, limited to the adapter.
- The Bot Framework vs Microsoft 365 Agents SDK wire protocol must be confirmed
  against current Microsoft docs before building (open question Q7).
