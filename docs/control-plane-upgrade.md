# Multi-agent control plane upgrade

This change extends the control plane at baseline `be13d0b`. It preserves the existing execution target, approval, event log, room, and Slack contracts. The later November 3 specification controls conflicting requirements. Reference verification and license findings are in [the reference audit](control-plane-reference-audit.md).

## Workspace and artifacts

The API accepts a `workspaceTarget` of `github` or `ephemeral`. Intake normalizes it into the established frozen `executionTarget`, so workspace identity, template hints, and required outputs participate in approval hashing. An ephemeral workspace has no repository or publication permission. It initializes `/workspace/.shiba` and `/workspace/out` without a clone. Existing artifact workspace callers retain their required text deliverable contract.

Archive collection reads regular files beneath `out/` from a retained immutable Git commit. It rejects traversal, symlinks, unsupported file modes, inconsistent hashes, truncated transport, and excess size or count. Empty directories and zero-byte files are supported. ZIP creation is bounded to 64 files, 1 MiB per file, and 8 MiB total input. Compression runs in Worker memory before the bounded archive is uploaded through the R2 binding. This is not an unbounded streaming zipper.

Provision the private `shiba-artifacts` bucket through the mirrored Wrangler or Alchemy configuration. Set the Worker secret `ARTIFACT_SIGNING_KEY` to at least 32 bytes and configure the public HTTPS `WORKER_HOSTNAME`. Missing configuration fails before sandbox acquisition. The download URL is a seven day, scoped HMAC capability served by the Worker over private R2. It is not an S3 presigned URL and requires no S3 credentials. Anyone holding the capability may download that bundle until expiry. Owner, run, sandbox, content digest, size, and expiry are bound into the capability.

The image adds pinned DuckDB and Agent Reach tools. Provider egress remains narrowly allowed. Installing a research tool does not grant arbitrary network access. Templates are bounded format hints, rather than remote executable installers.

## Bounded specialists

The coordinator exposes `explore_codebase`, approval-gated `delegate_coding_task`, and `review_diff`. Explorer and Reviewer are SDK `AIChatAgent` facets exported from the Worker. Their signed envelopes contain only explicit file snapshots, goal, context, specification, or diff. They have no shell, parent transcript, approval tools, integration credentials, or external write tools. Explorer searches only the supplied snapshot. It does not fetch an arbitrary repository.

A turn permits three sequential read-only inspections with a 60 second deadline. The remaining budget is durable. SDK child concurrency is set to one. Child routes require a retained tool run and an allowed class; children refuse nested facets. Coding child requests require a fresh workspace and a new frozen human approval, with depth one and at most three direct children. Parent budget consent cannot approve a different child task.

Coding dispatch uses a domain-separated HMAC over both the approved input digest and a SHA-256 digest of the complete canonical execution envelope. Owner routing, role, runtime, workspace, model, sealed environment, and bounded dispatch lifetime cannot change under an existing seal. Provider and subscription credentials remain at Worker egress.

## External actions

Automation triggers queue pending human approvals. Autonomous identities cannot resolve approval decisions. A coding child cannot publish a pull request.

When a coordinator run requests publication, the executor stages its exact file snapshot in private R2 and returns metadata only. After successful fenced completion, the coordinator creates a distinct `pr_publish` approval. Approving the initial run does not publish changes. The publication action binds owner, run, repository, base branch, sandbox, immutable object, and SHA-256 digest. The approved action is claimed durably before GitHub access. Mutation requests are attempted once. An interrupted or uncertain action is reported as unknown and is never automatically repeated or compensated with a branch deletion.

## Live rooms

The authenticated session room accepts server-owned terminal, status, diff, and child frames through binding RPC. Browser messages cannot append these frames. Each accepted frame has a durable sequence and stable event ID. Reconnect resumes from a cursor and deduplicates accepted frames. Retention is bounded to 2,048 frames. Expired cursors, failed delivery, oversized output, and interrupted execution transport produce an explicit gap or uncertainty indicator.

The existing run progress and diff components now include an xterm terminal, viewer presence, live diffs, run children, and session specialists. Socket leases prevent one viewer from taking over another viewer's browser relay stream. Navigation clears output and replay cursors; late frames from a previous session are ignored. A room append has a deadline and a circuit breaker so a stalled viewer service cannot hold execution indefinitely.

Browser reconnect and DO replay do not imply resumption of a lost CLI process. If harness transport is lost after output, the runtime reports uncertainty rather than replaying the whole command. Live Cloudflare container transport recovery still needs cloud acceptance.

## Slack

Lead, Explorer, Fixer, and Reviewer use distinct names and emoji with one configured bot token. Installations need `chat:write.customize`; existing installations may need to be reauthorized. The implementation does not claim multi-installation OAuth support or an `agent_view` status API. Progress updates edit a stable thread status message.

Use `workspace:<id>` in a mention or slash command to request a repo-free task. Run approvals disclose requested publication; the separate publication card approves the frozen external action. Callbacks verify the Slack raw-body signature and timestamp, approver allowlist, known action ID, and thread workspace scope. Unauthorized clicks produce an ephemeral denial without mutating approvals or runs.

Verified incoming events are buffered directly with author, event ID, text, and timestamp while a run is active. A separate signed internal request prevents callers from forging Slack authors. The queue is durable, bounded, deduplicated, and claimed before processing. Settlement creates a fresh pending approval from the complete attributed batch. Acknowledgment happens only after the new approval is durably recorded; restart uses the same command ID. No active CLI turn or frozen approval is rewritten.

## Verification and live acceptance

Required local gates are `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Deployment configuration drift is checked with `pnpm check:deploy`. The focused backend acceptance files are `test/ephemeral-sandbox.test.ts` and `test/child-dispatch.test.ts`, run from `apps/backend` with its existing Vitest configuration.

Meaningful failure coverage includes immutable artifact scope, empty and binary output, child timeout and tampering, forbidden nested facets, unauthorized Slack clicks, durable message recovery, action publication claims, replay cursors, stream takeover, navigation isolation, and stalled room RPCs. A real Chromium harness also checks xterm rendering, presence, diffs, specialists, reconnect ordering, session navigation, and a narrow viewport using synthetic server frames.

No merge or production deployment is included. Live sandbox and R2 export, provider execution, Slack scope installation and button delivery, and process transport recovery require an authorized cloud environment. Baseline deployment run `41679318599` failed during Alchemy planning on Cloudflare authentication and rate limits after the build passed.

## Recorded local results

The final November 3 local verification passed the full typecheck, Biome lint, import lint, application build, deployment configuration checks, and Dockerfile validation. The serialized complete test command passed all eight workspace tasks: 4,610 tests passed and three live tests were skipped. The requested ephemeral workspace and child dispatch files also passed in a separate focused run. Browser evidence is retained in [control-plane-browser.json](verification/control-plane-browser.json), which explicitly marks its synthetic transport and unverified cloud acceptance.

The additional unused-code inventory check remains failing on both this branch and untouched main at `be13d0b`. The inventories match: 20 unused files, one unused dependency, three unused development dependency groups, 27 unused export groups, and five unused exported type groups. This existing CI inventory is not reported as passing. No merge or deployment was performed.
