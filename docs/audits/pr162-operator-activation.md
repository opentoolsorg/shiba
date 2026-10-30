# PR #162 operator activation checklist

**Status checked 2026-10-30 at `42628dbda2156330717621cf9788377a8dee6719`.** Local deterministic tests, the browser Worker session, typecheck, lint, and self-hosting smoke pass. This checklist records the remaining external activation gates; it is not permission to execute them. No production deployment, live provider call, live sandbox run, Reason Network join, or external message was performed.

## Before a live provider and sandbox run

The browser acceptance uses a deterministic executor and does not start a real sandbox. To run one representative live task, the operator must:

1. Choose the provider/model and the self-hosted Shiba environment where its credential will be configured. Configure the credential through the supported secret or account flow; do not paste credential values into chat, issues, task prompts, or evidence files.
2. Identify an account-owned repository to use, or explicitly choose the artifact-workspace target if that path is supported by the selected live executor. For a repository test, state whether the run may only read and produce a local diff, or whether it may push/publish. Default to no remote writes.
3. Set the task, execution target, time/cost ceiling, and allowed external effects. Approve the exact task through Shiba's ordinary approval screen before dispatch.
4. Afterward, inspect the run record, artifact bytes/provenance, provider usage where available, and cleanup status. Record the exact revision and whether the run was a real provider/sandbox or deterministic local execution.

The operator's approval must name the intended provider/account, test repository or workspace, task, and permitted effects. This is separate from permission to deploy a preview or use another account.

## Before Reason Network dispatch

Reason Network setup is **not dispatch-ready**: `/api/reason-network/status` intentionally reports `setup_required`, `enabled: false`, and `dispatchConfigured: false`. Persistent grants and exact-payload approval records exist, but there is no application send route or installed MCP client wired to consume them. User approval alone cannot enable a path that is not implemented.

Before any send can be tested, the product needs a reviewed application-facing dispatcher and deterministic local MCP protocol test. After that code exists, a live activation still requires explicit owner opt-in and the exact already-installed executable path, owner/session, network, recipient/destination, approved message text, and whether the upstream wake behavior is acceptable. The operator must approve each exact outbound payload; no inbox polling or autonomous peer replies are supported. Do not install an executable, join a network, or contact a peer as part of this checklist.

## Before enabling build:validate on PR #162

Adding the `build:validate` label to this same-repository PR triggers CI and the `preview-deploy.yml` workflow. The preview workflow can provision a Cloudflare PR stage, apply migrations, use configured preview secrets, and post a PR comment. It is therefore a preview deployment action as well as validation.

Required authorization: explicitly approve applying `build:validate` to PR #162 with the understanding that it can create/update the isolated PR preview. Do not apply the label or retry its trigger before that approval. A successful local suite is not a hosted CI run.

## PR description update

Updating the existing PR #162 description is a separate GitHub write. The previous update attempt was rejected by automatic review. Do not retry it until the user explicitly authorizes that exact PR-description update. No new PR is needed.

## Web and Slack room continuity

Persistent Shiba web rooms and Slack approval/thread flows are separate surfaces. No web-room-to-Slack shared transcript or membership bridge is implemented by this PR increment. Do not describe the existing Slack integration as room continuity. Closing this gap requires a scoped implementation and a test workspace/channel with authorized membership; sending messages to real people additionally requires approval of the exact destination and payload. No Slack/Teams message should be sent to make local acceptance pass.

## Readiness statement

Until the above gates are completed, describe the result as locally verified with deterministic adapters. Keep live provider/sandbox execution, Reason dispatch, shared web/Slack rooms, and hosted CI/preview deployment marked unverified or blocked. Production readiness, remote recovery, cloud execution, and provider-backed output have not been established by the local checks.
