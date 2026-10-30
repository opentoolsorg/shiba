# PR #162 operator activation checklist

**Status checked 2026-10-30 at the local Slack continuity integration.** Local deterministic tests and the browser Worker session use fake adapters; they do not prove a live provider, sandbox, Reason network, or Slack installation. This checklist records the remaining external activation gates; it is not permission to execute them. No production deployment, live provider call, live sandbox run, Reason Network join, Slack installation, or external message was performed.

## Before a live provider and sandbox run

The browser acceptance uses a deterministic executor and does not start a real sandbox. To run one representative live task, the operator must:

1. Choose the provider/model and the self-hosted Shiba environment where its credential will be configured. Configure the credential through the supported secret or account flow; do not paste credential values into chat, issues, task prompts, or evidence files.
2. Identify an account-owned repository to use, or explicitly choose the artifact-workspace target if that path is supported by the selected live executor. For a repository test, state whether the run may only read and produce a local diff, or whether it may push/publish. Default to no remote writes.
3. Set the task, execution target, time/cost ceiling, and allowed external effects. Approve the exact task through Shiba's ordinary approval screen before dispatch.
4. Afterward, inspect the run record, artifact bytes/provenance, provider usage where available, and cleanup status. Record the exact revision and whether the run was a real provider/sandbox or deterministic local execution.

The operator's approval must name the intended provider/account, test repository or workspace, task, and permitted effects. This is separate from permission to deploy a preview or use another account.

The employee Gmail read path is restricted to messages selected from recent, owner-authenticated metadata discovery and rechecks grants at dispatch. This does **not** narrow the separate direct Gmail MCP token grant, which remains an explicit full-account read grant. Keep those two authority paths distinct when configuring an agent; do not infer selected-message limits from the employee-policy UI for a direct Gmail MCP token.

## Before Reason Network dispatch

The application-facing route and paired-daemon protocol are implemented and tested with a fake local MCP companion. The default remains disabled; local protocol evidence does not prove an upstream daemon, network, peer identity, or live delivery.

A live activation requires explicit owner opt-in, the exact already-installed executable path, owner/session, network, recipient/destination, approved message text, and acknowledgement that the upstream inbox-read operation acknowledges before returning. Approve each exact outbound payload. No inbox polling or autonomous peer replies are supported. Do not install an executable, join a network, or contact a peer as part of this checklist.

## Before Slack room continuity activation

The code now supports signature-verified Slack thread observation, explicit owner mapping to a Shiba room, deduplicated inbound replies, revocation, and a persisted outbound intent. The outbound worker is disabled by default. A deterministic route journey uses an injected mock installation and post receipt; it does not install the Slack app, grant scopes, read a live workspace, or send a real message.

Before connecting a real workspace, an operator must explicitly authorize configuring the Slack app manifest/subscriptions and installing or updating the app with the required event scopes. Configure `SLACK_SIGNING_SECRET`, then verify the intended workspace, channel, and thread through signed events before an owner maps that exact thread. For outbound delivery, separately configure `SLACK_ROOM_OUTBOX_ENABLED=true`, `SLACK_APPROVALS_CHANNEL`, the workspace's bot token, and `DASHBOARD_APPROVERS`. The outbox checks `auth.test` workspace identity, requires approval for the exact web-authored message, rechecks the link immediately before posting, and records the receipt. Ambiguous delivery is left `unknown` and is not automatically retried.

Sending to real Slack additionally requires explicit approval of the exact destination and message. Do not enable the outbox or modify a real Slack installation as part of local acceptance.

## Before enabling build:validate on PR #162

Adding the `build:validate` label to this same-repository PR triggers CI and the `preview-deploy.yml` workflow. The preview workflow can provision a Cloudflare PR stage, apply migrations, use configured preview secrets, and post a PR comment. It is therefore a preview deployment action as well as validation.

Required authorization: explicitly approve applying `build:validate` to PR #162 with the understanding that it can create/update the isolated PR preview. Do not apply the label or retry its trigger before that approval. A successful local suite is not a hosted CI run.

## PR description update

Updating the existing PR #162 description is a separate GitHub write. The previous update attempt was rejected by automatic review. Do not retry it until the user explicitly authorizes that exact PR-description update. No new PR is needed.

## Web and Slack room continuity

Signed, explicitly mapped Slack threads can now contribute inbound messages to a Shiba room, and approved outbound web messages can use a disabled-by-default one-shot outbox. This is not shared Slack membership, does not mirror unlinked thread text, and does not imply that a real Slack installation or workspace was activated. Keep those boundaries clear. No Slack/Teams message should be sent to make local acceptance pass.

## Readiness statement

Until the above gates are completed, describe the result as locally verified with deterministic adapters. Keep live provider/sandbox execution, live Reason-network dispatch, real Slack installation/outbound delivery, and hosted CI/preview deployment marked unverified or blocked. Production readiness, remote recovery, cloud execution, and provider-backed output have not been established by the local checks.
