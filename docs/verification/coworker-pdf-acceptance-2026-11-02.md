# Coworker acceptance audit — 2026-11-02

The regression fixes and local mock journey are verified. **The live employee loop is not complete.** Live account/authentication, Slack, provider execution, MCP token acceptance, and Slack-to-Tasks ownership remain unverified or blocked. Reviewed code passes 3,601 backend tests and 567 frontend tests; one offline-recovery environment failure keeps the complete backend gate red, with three existing skips unchanged.

## Sources and baseline

- **REA:** `Shiba bot operating model (REA).pdf`, 5 pages, 304,420 bytes.
- **Smooth:** `Shiba smooth coworker — test + fix.pdf`, 4 pages, 272,607 bytes.
- Both PDFs were materialized through Library into the cloud workspace, with Library identity retained and byte counts checked. Key diagram/table pixels were inspected; the separate source review inspected all nine pages. REA page 5 has a clipped heading and no body, Smooth page 4 has a clipped table start, and REA page 4 clips its final ledger column. No missing text was inferred.
- Fresh remote `main`: `e0b864854905e08409b341a537b301a42320e969`. GitHub confirms PRs #166, #177, #181, #183 and #184 merged. There were no open PRs at audit start. No work was based on merged PR #163 or an old recovery bundle.
- Initial code and harness snapshot: `f8754ddec899a1a78369e4ff1a6dd8f21bee30f5`. Follow-up triage and independent-review corrections are recorded below. Commits use `princepal9120 <107296821+princepal9120@users.noreply.github.com>`.
- Reviewed implementation snapshot: `7126b6914739803448df1d90dccf780fc532f6bd`. Later commits only correct deployment-policy documentation and record this evidence; no remote CI conclusion is implied.

## Requirements matrix

| Requirement and PDF source | Current code / proof | Result and remaining limit |
| --- | --- | --- |
| Orchestrator owns intent, coding is delegated, human approves before execution (REA pp1–3) | Existing orchestrator/harness boundary; `phase1-core-loop.integration`, tradeoff contracts and Codex subscription tests | Local contracts pass; no real provider run performed. |
| L0: `/app/`, navigation, task states and composer (Smooth pp2,4 visible row) | Browser loads real built Worker assets; Work → New task → Work mode opens the composer | Local pass. Current equivalent labels are Needs approval, Running, PR open, Needs attention and Done; no new bucket design was introduced. |
| L1: typecheck and MCP coworker/gateway/run-tool contracts (Smooth p2) | Full typecheck and SDK synchronization; focused backend run | Pass: 239 tests across 17 files. Complete backend suite remains red as detailed below. |
| L2: honest setup flags and actionable checklist (Smooth pp1–3) | `setup-status.ts`, `OnboardingModal`, `ConversationalOnboarding` | Whitespace credentials and malformed/empty/invalid Slack repo maps stay false. Slack completion requires a usable map. Failed model-role checks cannot be overridden by a reachable gateway. A responding API no longer asserts paid billing. Failed initial onboarding reads block writes until recovery. Live setup endpoint blocked. |
| L3: identify the actual account owning the host/resources (Smooth pp2–3) | Current `wrangler whoami`; separate read-only connector audit | Blocked: CLI is not authenticated. The connector audit found no visible `tryshiba.dev` zone in its exposed account; that does not establish which account owns the target. An Access-app read in that account returned 403/code 9999 and stopped. No denied read was retried and no account ownership or target Access state was inferred. |
| L3: supported auth lane and preview forwarding (Smooth pp2–3; REA pp3–4) | `deploymentConfig`, `alchemy.run.ts`, `preview-deploy.yml`, deployment tests | Public stages retain managed Access via `ACCESS_EMAILS`, or Better Auth secret plus bootstrap token/owner email. Both deploy and destroy steps now forward all three existing Better Auth settings; independent review caught missing teardown forwarding. Seven pure deployment tests pass without operating on real resources. No guard or live policy weakened. |
| L3: real host returns intended app/login/Access content (Smooth p2; REA pp3–4) | TLS-verified GETs of `https://app.tryshiba.dev/app/` and `/api/setup/status` | Both returned HTTP 403, body `error code: 1010`. This is a blocker, not proof of a working application or login. No certificate, proxy, Access or WAF bypass attempted. |
| Provider/chat scope (REA pp2–3) | Shared integrations schema is `z.enum(["openconnector"])`; backend provider and dashboard contracts agree | OpenConnector-only provider selection already landed. This audit exercises Slack only; no other chat lane was activated or added. Existing compatibility handlers are not evidence of live support. |
| L4: signing secret, bot token, approvers, channel/repository map, installation/webhook (Smooth pp2–3) | Setup booleans and Slack ingress/config contracts | Live blocked: this environment has no configured credential bindings, and no approved test workspace/channel or installation was supplied. No external message sent. |
| L4: mention → same-thread approval (Smooth pp1–2) | `slack-mention`, `slack-approval`, synthetic full-loop integration | Pass locally. Current signed event is retained even when fetched history lags. Escaped card sections fit Slack's 3,000-character limit without truncating the frozen task. |
| L4: one logical Approve/Deny decision, no execution before approval (Smooth pp1–3) | Signed Block Kit interaction through the real orchestrator queue; mock harness spy | Local pass. Unconfirmed initial card delivery retries once using the same approval pointer, never a second queued task. A lost acknowledgement can still display duplicate cards for that one logical approval. |
| L4: no-card / card-no-run failures are honest (Smooth pp1–2) | Separate queue vs card-delivery handling; fixed safe setup-error categories | Regression cases pass. Arbitrary upstream error bodies are not echoed into Slack. Persistent Slack failure can still leave an undelivered pending approval; initial delivery has no durable retry ledger. |
| L4: approved execution/progress/result + PR in place (Smooth pp1–2) | Synthetic Slack integration; browser Worker journey and mock GitHub read-back | Local pass for same-thread start/result/PR, plus synthetic coding completion and review. Real sandbox/model/provider execution and live Slack delivery remain blocked. Existing terminal outbox code is not claimed as live outage proof. |
| L5: dashboard shows the SAME Slack run (Smooth pp1–3) | `runs-routes`, `approvals-routes`, Slack thread naming, collaboration links | **Unresolved ownership prerequisite.** Slack runs live in `slack:{team}:{channel}:{thread}` DOs; dashboard reads owned user/session DOs. Repo maps and Slack approver IDs do not bind a dashboard identity. Room-import links authorize room messages, not run visibility or approval ownership. No cross-user access was broadened. |
| L5: composer and same dashboard-run state (Smooth pp1–3) | Browser composer filled, approval displayed, exact default run completed and selected in Diff | Local pass through documented API submission/approval seam. This is not a browser Send/Approve-click or live chat inference claim. Driver explicitly selects Default Session before queueing the default API run. |
| L6: repeat request context, clean denial, truthful setup (Smooth p3) | Slack follow-up and rejection integration; onboarding read/unlink regressions | Local pass: prior context plus current ask retained; denied request invokes no harness. Delayed send failure cannot reattach an explicitly unlinked first-task goal. Live happy-path continuity unverified. |
| MCP token/account/KV consistency (Smooth pp2–3) | Current MCP contracts and configured binding references | Contracts pass; no production token minted or inspected. Live token acceptance in the intended account's `shiba-agent-tokens` KV remains unverified. |
| Verify artifact, not Actions conclusion (REA pp3–4; Smooth p3) | Actual live HTTP status checked; workflow triggers inspected | No preview deployment requested. `build:validate` triggers both CI and a preview deploy, so it is intentionally not applied just to obtain a badge. Exact remote-head checks must be read as absent until that workflow is deliberately authorized. |
| Isolated known-SHA work, proof, merge/publish gates (REA pp1–3) | Five implementation commits on a new branch; this dated matrix | No squash, approval, merge, auto-merge, production deployment, secret change, OAuth grant, app installation, or production migration. Historical Gemini/Luna/Mac examples were not applied. |

## Changes

1. `d4d079b`: employee dispatch rechecks profile, membership, capabilities and resource/connection authority after awaited invocation claim; external MCP rechecks server/tool state after authorization. Nine deterministic revocation-race regressions added. One MCP test fixture explicitly allowlists its intended human operator.
2. `90fdf64`: preserve the current Slack event in thread context; distinguish queue rejection from uncertain card delivery; retry the same approval once; use safe setup hints; split escaped approval text within Slack limits. Mock Slack integration covers mention, approval, execution, same-thread PR result, follow-up and denial.
3. `b7b4614`: block onboarding mutations after failed initial read; preserve explicit goal unlink on delayed failures; make repeated Electron quit attempts wait for daemon cleanup. Updated incompatible assertion helpers without changing their checks.
4. `68e2db7`: honest setup readiness and Slack mapping checks; model-role/billing checklist fixes; forward existing Better Auth settings into preview Alchemy.
5. `f8754dd`: repair the local browser journey's navigation/session selection, ephemeral mock signing fixture and GitHub identity/review fixtures. Signing fixtures are invocation-scoped, preserve existing operator keys, and are never introduced in live/container mode.

## Follow-up: exact causes of the 96 backend failures

The original failure set contained **94 stale test-fixture failures, one product defect, and one environment limitation**. An exact case-by-case ledger is in [backend-failure-triage-2026-11-02.json](backend-failure-triage-2026-11-02.json). All 95 repairable original cases now pass; the offline inspection failure remains visible and was not skipped.

| Original failing cases | Cause and repair | Acceptance relevance |
| --- | --- | --- |
| 49 | Shared approval fixtures lacked explicit intended human approvers or used the wrong owner identity. Added fixture allowlists and drained fake background work between cases. New unauthorized Approve/Deny cases preserve pending state and execute nothing. | L1 and synthetic L4 approval, replay, execution and outbox contracts. |
| 30 | Provider/custom-agent browser mutations lacked required same-origin Origin headers. Supplied genuine fixture provenance, with missing/foreign/cross-site origin denial regressions. | L1 provider admission and authorization prerequisites to L4. |
| 3 | Tests conflated dashboard tenant org with thread owner. Assert the current `self-hosted` org while retaining owner isolation and adding foreign-owner refusal. | L1/L5 ownership contracts. |
| 4 | Worker tests supplied an unverified Access email header. Use locally signed RS256 JWTs through the real verifier; forged headers are still denied. Valid scoped bearers still cannot acquire shared runtime access through ambient identity. | L1/L3 auth contracts; no live Access proof. |
| 5 | Dashboard fixtures opened Tasks while asserting Threads in Work mode, or expected obsolete empty-state copy. Corrected fixture route/mode and retained behavioral assertions. | L0/L5 local rendering. |
| 1 | Actual product defect: `CuratedMcpConnections` accessed `window.location` during server render. Read it only on the OAuth click. Added no-browser/no-network SSR and client-origin regressions. | L0/L2 integrations rendering. |
| 1 | Evidence mock lacked the identity and ownership metadata required by artifact authorization. Added owner metadata and negative cross-owner/unauthenticated tests. | L1 proof access. |
| 1 | Sandbox fake omitted `approveHarnessEgress`, failing before its intended terminal repository-scope error. Added that fake step and asserted it runs once; clone still does not run. | L1/L4 preflight and retry safety. |
| 1 | Usage route fixture fixed records to October 2 but used the real current date. Pin only the test's clock to its asserted bucket. | L1 deterministic usage verification. |
| 1, still failing | Offline recovery invokes `lsof -F p +D <isolated persistence root>`. Here it exits 1 with `can't stat() mqueue file system /dev/mqueue` and `Output information may be incomplete.` The recovery tool correctly refuses to assert an offline state. An independent empty-directory probe reproduced the same diagnostics. | Outside the coworker L1/L4 slice. Run recovery acceptance on a runner with complete file-descriptor/filesystem visibility; do not suppress warnings, weaken the guard, or call the full suite green. |

Follow-up commits: `56fe17d` approval fixtures; `8acb7c4` browser/JWT/tenant provenance; `a47d161` SSR fix and regression coverage; `c1ea78d` artifact/retry/date fixtures.

Independent Sol review then found two P2 issues in the proposed changes. Both were reproduced and corrected:

- `f566631`: Better-Auth-only preview teardown imported the same public-stage guard without receiving its auth configuration. The new teardown regression failed before the fix; deploy and destroy now pass equivalent existing configuration. No deployment or teardown was executed.
- `7126b69`: a D1 read rejection after an employee invocation claim left a dispatching receipt even though its handler never ran. The pre-dispatch refresh catch now persists a known failed receipt, returns a sanitized 503, and keeps same-key retries behind the consumed-approval fence. Two injected profile/grant failures reproduced the bug. A separate provider-throw regression proves failures after invocation starts retain `unknown_outcome` rather than being misreported as no-dispatch failures. All 101 tests in nine focused authority/MCP suites pass.

`4a45fbc` also corrects legacy deployment documentation: Alchemy does not preserve missing declared secrets, and the manual Worker workflow lacks current live preflight inputs. Its executable configuration was not enabled or extended. [The deployment runbook](../DEPLOY.md) expressly limits deployment and secret changes to the owner on a trusted Mac; existing CI workflows are not an exception. Cloud work here is code, tests and read-only diagnosis only.

## Verification record

The cloud uses Node 24.19.0 and the repository-pinned pnpm 10.34.4. The globally provided pnpm 11 was unsuitable for this lockfile; the lockfile was not changed. `XDG_CONFIG_HOME` points inside the workspace and `TURBO_ENV_MODE=loose` forwards that writable cache setting to subprocesses. TLS verification and the inherited proxy remain enabled.

| Check | Outcome |
| --- | --- |
| `pnpm typecheck`, including SDK generated-type synchronization | Pass, all 10 tasks. |
| `pnpm lint`, `pnpm lint:imports`, `pnpm check:ci` | Pass with repository warnings / existing Knip findings. No new lint error gate. |
| `pnpm build`, `pnpm docs:verify`, `pnpm test:built` | Pass; 79 HTML pages and 6,012 local references checked; built marketing test passes. |
| `pnpm check:deploy` | Pass; binding parity plus seven deployment/auth tests, covering both deploy and teardown forwarding. |
| Focused backend regression/contracts run | 239 tests pass in 17 files. |
| Full frontend | 567 tests pass in 87 files after SSR follow-up; existing localhost-fetch warnings are present. |
| Other workspace packages | All six test tasks pass: ACP server 9, SDK 14, desktop 204, login 3, sandbox 39, auth 12. |
| Initial complete backend | 3,493 pass, 96 fail, 3 skipped across 285 files. All 96 failing case names matched an isolated unchanged `e0b8648` checkout. The follow-up above repairs 95 original cases without weakening authorization assertions; final reviewed counts are recorded at handoff. |
| Final reviewed complete backend | **3,601 pass, 1 fails, 3 skipped across 285 files.** The sole failure is the offline-recovery `lsof` visibility limitation above. All 95 repaired original failure cases still pass after both independent-review corrections. No tests were removed or newly skipped. |
| Credential/approval/repository-scope tradeoffs | Pass: 28 tests across tradeoff contracts and Codex subscription checks. |
| Browser `core-loop-mock` | Pass again after SSR/fixture follow-up: 11 assertion steps. Coding run `agent-tool:26d4e9f5-af42-4ecb-b68e-4cb30b889c7d`, mock PR `https://github.com/mock/repo/pull/1`, mock head `abc123`, review round `posted`. Models/container execution are synthetic, GitHub is a loopback stub, and approval is via API. |
| `pnpm env:scan` | Pass. |
| `pnpm env:load` using unchanged `.env.example` | Blocked as expected: required `CLOUDFLARE_ACCOUNT_ID` is empty. No account ID was invented. |
| Docker-backed `wrangler deploy --dry-run` | Incomplete, canceled with exit 130. Managed Docker 28.4.0 is available. After moving only Buildx scratch state to a writable workspace path, image pulls succeeded, but the pinned global-agent dependency-install step produced no progress for over five minutes. Only the exact local dry-run clients were canceled. No deployment or trust-store change occurred. |

Local logs and raw results are under `/workspace/shiba-inputs/`. The latest browser artifacts are under `.verify/evidence/ci-local-20261102T065203Z/`, including `result.json`, `assertions.json`, `review-round.json`, screenshots and trace. Those paths are cloud-local artifacts, not a deployed preview or remotely uploaded CI artifact. Fixture and worker ports were cleaned up after verification.

## Smallest remaining prerequisites

1. The operator must identify and connect the Cloudflare account that actually owns `app.tryshiba.dev` and its resources. Current `wrangler whoami` is unauthenticated; public app/setup requests return 403/1010. Existing auth protection should be inspected in that account, not bypassed.
2. Supply a verified Slack workspace, channel, intended repository, permitted approvers and installed app/webhook, and explicitly authorize one tiny live task and its model/provider cost. Validate the gateway or subscription route in that same account. No live destination or paid synthetic task is assumed.
3. Before Slack-to-Tasks parity can be implemented, approve an explicit association between the Slack team/channel/thread and an authenticated dashboard owner (with revocation and negative cross-user tests). A room-import link alone is insufficient authority. No existing verified run-ownership association was found; current code also lacks the enrollment/read wiring for that association, so this is a remaining engineering gap as well as an operator-mapping prerequisite.
4. Verify the intended MCP token binding in that account without minting a production token as QA. The remaining local-recovery environment failure must also pass on a capable runner before treating the full repository gate as healthy.
5. Establish a validation-only CI path consistent with the owner-Mac-only deployment policy. Do not apply `build:validate` or dispatch legacy deployment workflows: those currently deploy or tear down resources. Absent checks or a skipped deployment do not establish a working artifact.

## Review handoff

The implementation branch is `fix/coworker-pdf-acceptance`. Creating the draft PR was attempted once through the GitHub connector and **denied by automatic approval review**: it classified opening a draft PR as an external repository commitment without explicit user authorization to publish/open it. No PR was created and no alternate route was attempted. The prepared PR description and source manifest remain in the cloud workspace. Opening the draft PR is pending explicit approval; the already-pushed branch remains available for review.
