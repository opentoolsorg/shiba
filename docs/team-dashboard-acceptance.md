# Team dashboard acceptance

This follows the [phase matrix](control-plane-acceptance.md) and [shared context report](shared-context-employees-acceptance.md) for PR #188. Implementation, local browser evidence and installed-service verification are separate. Complete Overlay/Grok product parity is not claimed.

## Reference boundary

The public [Overlay demo](https://www.getoverlay.io/home) and [Grok Bot demo](https://x.ai/bot) informed workspace navigation, chat/roster layout, Work filters and execution details. Their authenticated dashboards and persistent computers were unavailable. [Overlay's feature inventory](https://github.com/LayerNorm/overlay-web/blob/1e1892e301506d08afcfce8bf9c670a6296940be/FEATURES.md) also distinguishes advertised computers from default runtime paths. No proprietary assets, sessions or application code were copied. Upstream REA instructions were inspected; REA was not installed or executed.

## Implementation matrix

| Area | Implemented contract | Evidence and limits |
| --- | --- | --- |
| Workspaces | D1 directory, owner/admin/member roles, versioned mutations, last-owner protection and explicit email-bound invitations. | Store, route and real Worker ingress tests. Workspace roles grant no deployment administration. |
| Enrollment | Single-use hashed tokens, expiry, current issuer/version, immutable account provenance and fresh verified-email/session checks. | Email sends are captured fixtures. Real delivery needs configured `SEND_EMAIL`, an already verified `BETTER_AUTH_VERIFICATION_FROM`, and HTTPS `BETTER_AUTH_URL`. Missing configuration disables enrollment. Verification does not automatically accept membership. |
| Team chat | Main Threads opens selected workspace rooms with attributed messages, verified member choices, presence/typing and People/Context/Work/Slack/Execution tabs. | Current HTTP authority and websocket invalidations remain; viewer IDs confer no authority. Private history is never copied automatically. |
| Context/memory | Explicit bounded message/note selection, author/provenance, immutable revisions and digest binding into approval. | Current source, room and workspace grants are rechecked. Private owner Memory remains separate; no global team transcript or shared JavaScript heap. |
| Work | Workspace list/board/timeline, human assignment and exact room/handoff navigation. | Only readable rooms are projected. Unknown runs remain unknown. “Needs you” requires requester-only pending approval proof, not role or ID inference. |
| Approvals | Complete frozen card, explicit review, exact hash, requester identity, current `approval.decide`, profile/source/version checks and atomic decision fences. | No default/shared approval fanout. Publication stays separately approved. Replay, revocation and changes during admission are tested. |
| Execution | Read-only trusted terminal/diff/status/specialist replay for the exact approved linked run, with cursor pagination and explicit retention gaps. | Access is checked before and after awaits. This is not a persistent browser, desktop or login vault. |
| Artifacts | Authenticated selected-workspace downloads with current grants rechecked after R2 reads. | Private/no-store, bounded text and exact approval/profile/artifact proof. Archive bearer links do not grant room access. |
| Employee recipes | Human-reviewed bounded JSON, captured profile ownership, digest/version previews, transactional idempotent import and explicit legacy-copy flow. | Imported bots are archived; copied skills are drafts. App/MCP requirements and routine descriptions do not connect, authorize or schedule anything. Legacy ownership is not inferred. |
| Skills/onboarding | Team-local draft review/activation/disable/history and explicit shared-start actions; optional existing employee setup remains intact. | Team extension/library installation, skill version editing and a team onboarding-draft contract remain unavailable. |
| Account changes | Scope-keyed UI, request generations, stale-response rejection and actor-specific saved repositories/drafts/skills. | Failed/removed workspace access never silently opens personal history. Legacy unscoped browser records remain untouched and unclaimed. Invitation fragments are cleared only after committed state capture. |
| Slack | Existing buffered turns, exact source owner/audience policy, signatures, human decisions and outbox receipts remain. | Installed Slack execution is unverified. Multi-install OAuth and native Slack `agent_view` manifest support are not added. |

## Execution and billing boundary

Existing deployment-operator Claude/Codex routes retain their supported runtime/account contracts. Native invited users cannot adopt deployment credentials or billing authority by creating a workspace, becoming owner or approving a task. Legacy private runs/sessions/sockets/global approvals, deployment OAuth/MCP administration and provider mutations are denied for those accounts. They can collaborate and read deliberately shared operator-requested results while current grants remain valid. Their employee execution requires an explicit personal-provider/billing grant, which is not implemented.

The ten optional employee roles are engineering, design, marketing, GTM, sales, operations, HR, finance, product and research. Recommendations grant no tool authority. HR/finance templates produce reviewed drafts. Amount-aware spend still needs the user's integration/provider, operation, amount and currency decision. No purchase or spend integration was invoked.

The earlier journal supports bounded same-container recovery and explicit loss indicators; strict zero-dropped-output recovery after container replacement is not guaranteed. The terminal uses the existing xterm DOM renderer. ZIP creation remains bounded in memory before private upload rather than streaming compression.

## Verification

Focused tests cover administration, actor isolation, chat, replay, artifacts, workspace/source races, approvals, native enrollment and real Worker ingress. Aggregate TypeScript and all six deployment configuration checks passed. Final aggregate and browser results are recorded after their runs settle.

The local browser acceptance uses the production frontend build and actual local Worker/DO/D1/R2 with three independent password sessions. Additional invited users are explicitly labeled local verified-email fixtures; real mail delivery is not claimed. Containers, external providers, Slack sends and production mutations are disabled. Passwords, cookies, one-time tokens and private fixture databases are removed after evidence collection. UI mocks and local execution cannot establish deployed-service acceptance.

## External blockers

The user later supplied the existing [PR preview](https://shiba-ai-coworker-pr-188.opentoolsorg.workers.dev/). Read-only HTTP checks verified public HTML and an unauthenticated `whoami` 401. Its 1,677,930-byte `index-DyyXOLPC.js` bundle has SHA-256 `cb2ea3b51261976f6d8a323eae12f7bf04057ae100387bb612453f7572313341`, matching the prior local `app-public` asset and lacking the new team workspace UI. There is no deployed Git SHA metadata, so an exact backend commit is not asserted. It does not yet verify this unpushed implementation. No live account or credential was created.

The non-production [preview attempt 41835676558](https://github.com/opentoolsorg/shiba/actions/runs/41835676558) built successfully, then failed because the Cloudflare Alchemy state store was absent. Creating that persistent account-level backend requires the appropriate account/permission approval; it was not bootstrapped automatically. This attempt produced no verified preview URL.

Live email, installed Slack callbacks, R2 signing, inference and paired local machines require an authorized configured test environment. Production is unchanged; nothing was merged or deployed to production. Bootstrap provenance is immutable: deleting user rows alone does not safely reopen first-account signup. Account recovery must be an explicit audited operator procedure.

## Coordination

Ten areas ran in waves within the seven-slot limit (lead plus six delegates): identity/invitations, workspace APIs, shared chat, execution replay, employee recipes, Work projections, workspace administration, employee/skill onboarding, independent security review, and browser acceptance. Integration, aggregate verification and final push belong to the lead. Ten delegates did not run simultaneously.
