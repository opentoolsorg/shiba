# Chat channel end-to-end acceptance

This is the implementation and operator checklist for Slack, Discord, and Microsoft Teams task intake. The product contract is identical on every channel: a human writes an explicit task, Shiba freezes the exact repository/task input, a listed human approves that exact input, execution starts only after approval, and the result returns to the originating conversation. Channel credentials never enter a sandbox.

## Current implementation matrix

| Capability | Slack | Discord | Microsoft Teams |
|---|---|---|---|
| Signed inbound webhook/interaction | Yes — Slack HMAC and replay window | Yes — Discord Ed25519 | Yes — Bot Connector JWT, issuer/audience/expiry/service URL checks |
| Redelivery dedupe | Yes | Yes | Yes — local ring plus injectable durable dedupe |
| Repository resolution | URL, channel map, or explicit correction flow | URL, option, or channel map | URL or `TEAMS_CHANNEL_REPOS` conversation map |
| Approval card in source conversation | Yes — Block Kit | Yes — buttons | Yes — Adaptive Card `Action.Submit` |
| Approver allowlist | `SLACK_APPROVERS` | `DISCORD_APPROVERS` | `TEAMS_APPROVERS` Entra object IDs |
| No execution before approval | Yes | Yes | Yes |
| Result post-back | Yes | Yes | Yes — saved Connector reply address |
| Installation/connection management | Yes — owner installation flow | Yes — OAuth server installation flow | Yes — owner enable/disable plus observed install state |
| Pull-request publication from channel approval | Supported through Slack's publication boundary | Depends on employee/execution target | Not currently supported; documented as a Teams limitation |
| Live third-party acceptance | Requires operator workspace/app credentials | Requires operator application credentials | Requires operator Entra/Azure Bot/Teams credentials |

"Yes" means code and local integration coverage exist in this repository. It does not prove a live Slack workspace, Discord server, or Teams tenant until the operator completes the acceptance steps below with real credentials.

## Required security invariants

1. The signing secret, bot token, client secret, public key, or connector JWT validation material stays in the Worker. It is never written to the Teams app package, a channel message, frontend JavaScript, or a sandbox.
2. An empty approver list approves nobody. Channel membership is never approval authority.
3. Button/card payloads are pointers, not capabilities. The Worker re-resolves the pending approval and conversation binding before deciding.
4. Duplicate deliveries and stale connection generations cannot queue a second run or revive an old approval.
5. Rejecting an approval starts no sandbox and no model execution.
6. Status APIs expose booleans/counts only, never secret values, tenant private identifiers, channel maps, or approver identifiers.
7. Result text is bounded and redacted before returning to a channel.

## Operator setup order

1. Deploy database migrations, including the channel connection tables.
2. Configure GitHub publication and model provider access before testing a real task.
3. Configure one channel at a time:
   - Slack: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APPROVERS`, optional `SLACK_CHANNEL_REPOS`, then the Slack app request URLs/scopes and workspace installation.
   - Discord: `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, OAuth client settings, `DISCORD_APPROVERS`, optional `DISCORD_CHANNEL_REPOS`, then portal interactions URL and server installation.
   - Teams: `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, `TEAMS_WORKSPACE_ID`, `TEAMS_APPROVERS`, optional `TEAMS_CHANNEL_REPOS`, then Azure Bot messaging endpoint, generated app ZIP installation, and workspace-owner enablement.
4. In Integrations, confirm each row is not merely “configured” but has the required installation/connection state. Microsoft Teams also appears in setup details with deployment presence signals.
5. Run the live acceptance script below in a small test conversation.

## Live acceptance script per channel

Use a repository and task that cannot publish externally, for example a read-only summary task.

1. Send a message that does not address Shiba. Expected: no response, no approval, no run.
2. Send `@Shiba` or `/shiba` without a repository or mapped conversation. Expected: usage error, no approval, no run.
3. Send a valid repository and task. Expected: exactly one approval card in the same conversation showing the full frozen task or a linked/truncated honest representation.
4. Press Approve as a user not in the approver list. Expected: refusal, approval remains pending, no sandbox or model execution.
5. Press Reject as an allowlisted approver. Expected: card updates/resolves, no execution.
6. Repeat the valid request and press Approve as an allowlisted approver. Expected: exactly one run starts.
7. Redeliver or duplicate the original inbound event if the platform does so naturally. Expected: no second approval or run.
8. Wait for completion. Expected: one bounded result in the originating conversation, with secrets redacted.
9. Disable/disconnect the channel integration. Expected: new requests are ignored or refused and old cards cannot authorize work.
10. Re-enable/reconnect. Expected: previously accepted messages are not replayed; a new message is required.

## Local verification commands

```sh
pnpm --filter @shiba/backend exec vitest run \
  test/slack-approval.test.ts \
  test/discord.test.ts \
  test/teams.test.ts \
  test/teams-worker.integration.test.ts

pnpm --filter @shiba/backend exec vitest run test/setup-status.test.ts
pnpm --filter @shiba/frontend exec vitest run src/components/IntegrationsView.test.tsx
```

The Teams worker integration test covers signed JWT verification, tenant rejection, owner enable/disable, installation observation, duplicate delivery, foreign user/thread approval refusal, approval execution, completion post-back, stale-generation suppression, and removal observation. Slack has broader legacy coverage because it is the most mature channel; Discord coverage includes interaction signatures, approvals, mentions, installation state, and gateway intake.

## Remaining implementation gaps

These gaps are explicit product work, not hidden acceptance claims:

1. Teams cannot approve pull-request publication from a Teams card. Keep Teams tasks read-only or use the dashboard/Slack publication boundary until this is implemented.
2. Slack has the richest multi-installation/coworker feature set. Discord and Teams should not be described as having every Slack-specific capability.
3. Teams context/history support is limited; the adapter intentionally does not claim Graph history support.
4. Live acceptance requires real operator-owned apps and test tenants. Repository tests cannot create or prove those external resources.
5. Desktop/mobile notifications for channel approvals are separate product work.
