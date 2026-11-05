# Optional Slack native agent sessions

Native session status supplements the existing Slack thread cards. Ordinary
personas, human approvals, attributed next-turn buffering and completion posts
do not require it. This capability is disabled by default and has not been
certified against an installed Slack app in this change.

## Configure an existing authorized installation

Slack's current [session method](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/)
is `agents.sessions.setStatus`. It uses `chat:write`; it is not a method named
`agent_view`. The [manifest reference](https://docs.slack.dev/reference/app-manifest/)
defines `features.agent_view`. Changing an existing `assistant_view` installation
to `agent_view` cannot be reversed, so an operator must review that change.

1. Start from `slack-app-manifest.yaml`. Add these fields under `features` in
   the existing manifest, preserving its slash command, bot and event settings:

   ```yaml
   agent_view:
     agent_description: "Approval-gated tasks with private execution and shared results."
     suggested_prompts: []
   app_home:
     messages_tab_enabled: true
     messages_tab_read_only_enabled: false
   ```

2. Add `assistant:write` to the existing bot scopes. Keep `chat:write` and
   `chat:write.customize`. Slack's [session guide](https://docs.slack.dev/ai/agent-sessions/)
   requires an agent-declared app; declaring one adds `assistant:write`.
   Review and reinstall the app if Slack requires consent for the changed scope.
3. Configure the existing `SLACK_CANVAS_OWNERS` exact team/channel owner policy.
   Native status requires the same frozen, signed Slack source and per-run room
   binding. It does not broaden channel visibility or add dashboard viewers.
4. Set `SLACK_AGENT_SESSIONS_TEAM_ID` to that exact Slack workspace ID, then set
   `SLACK_AGENT_SESSIONS_ENABLED=true`. Keep the token in Worker secrets.
   The adapter checks `auth.test` and its `x-oauth-scopes` response before a write.
   Missing scope evidence or a workspace mismatch blocks native delivery.

No account, credential or installation is created by enabling the code. Do not
enable it on an unverified installation. No native stop-event subscription is
added: the original turn contract queues follow-ups without interrupting an
active CLI. Slack documents a non-interactive loading indicator when the app
does not subscribe to `agent_session_stopped`. The ordinary explicit human
cancellation controls retain their existing behavior.

## Delivery and failure contract

The trusted orchestrator derives the status from retained approvals and runs:
`suspended` for a pending human decision, `processing` for active approved work,
and `active` when ready for another task. It never interprets a native status as
an approval. The adapter sends no task text or provider credentials to Slack.
The handoff runs after the orchestration state commits and is reconciled on
start and reclaim. Its native private helpers have no external RPC method.
Retained provenance and the current lifecycle are checked again after the
awaited installation check, immediately before the status write.

The Durable Object stores the latest desired status and committed event revision
before network access. An older revision cannot overwrite a newer intent, and
same-revision conflicts fail. Replay of a pending, unclaimed intent survives
object replacement. A write receives a durable claim before delivery. Confirmed
replays do not send again; a claimed write without a receipt becomes `unknown`
and is not automatically repeated. A newer lifecycle intent can still be sent.
This is a bounded status outbox, not an exactly-once Slack transaction.
Unchanged lifecycle values are coalesced even when unrelated orchestration
events advance the revision, so they do not indirectly retry uncertain writes.

`blocked` retains actionable codes such as `agent_scopes_missing`,
`scope_verification_unavailable`, `bot_workspace_mismatch`, `feature_disabled`
and `destination_not_authorized`. They are not displayed as connected or sent.
After repairing installation or policy, a different lifecycle status or a new
source approval is needed for another attempt. An unrelated higher event
revision with unchanged status does not retry a blocked or unknown write.
`sent` requires Slack to confirm the calling agent's status.
The aggregate session status is recorded separately because another agent can
keep the whole session busy. A timeout, malformed receipt, or partial server
failure remains `unknown`. Same-revision automatic retry is intentionally absent.
Slack automatically ends a `processing` indicator after one hour. This adapter
does not promise an indefinitely renewed indicator for longer-running work;
ordinary durable task state and completion delivery remain authoritative.

## Verification and remaining boundaries

`apps/backend/test/slack-agent-sessions.test.ts` uses fixture HTTP with real
adapter and storage code. It covers default-off, durable pending replay,
persist-before-send, frozen destination tampering, policy revocation, workspace
and scope failures, unavailable native features, uncertain delivery, stale
revisions, concurrent status changes and an abandoned claim after object
replacement. It does not prove installed Slack delivery, consent, scopes,
rate-limit behavior or user-visible native session rendering.

`apps/backend/test/slack-agent-session-orchestration.test.ts` also exercises
signed queue intake, the human approval route, deferred child work, completion,
restart recovery, revoked/forged sources and a failed orchestration commit.
Its Think persistence and HTTP transports are fixtures. No Slack or model
provider is contacted by these tests.

Live acceptance needs an authorized isolated Slack conversation, an installed
agent-enabled app, verified workspace policy and the deployed exact revision.
Exercise approval pending, approved execution, completion and failure while
checking the same Slack thread. Confirm unauthorized clicks still have zero
decision effects. Keep live evidence separate from fixture results.

Multi-installation OAuth remains a product gap. The current deployment has one
Worker bot token and one signing secret. Supporting multiple installations needs
an installation registry with encrypted per-workspace credentials, verified
installation ownership and audiences, token rotation/revocation, event routing,
and explicit per-installation approver/source policies. A team ID or bot-visible
channel alone cannot authorize access or sharing. This optional status adapter
does not claim to implement that contract.
