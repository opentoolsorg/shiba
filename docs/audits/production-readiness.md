# Production acceptance and remaining work

Reviewed on 2026-10-28 on `codex/overlay-parity-audit`. This is an acceptance
checklist, not a production certification. The current evidence supports a
working local development environment and specific local bot/thread flows.
**Production readiness and full Overlay parity remain NOT VERIFIED.**

The [reference audit](overlay-reference.md) contains both architecture diagrams,
the complete 19-category comparison, source traces and features to avoid copying.
The [runtime report](runtime-e2e.md) records actual browser/service results and
the [integration audit](integrations-audit.md) records storage, MCP and scheduler
boundaries. The final implementation report should be used for combined test
totals after all concurrent changes have been integrated.

## Acceptance evidence and limits

| Area | What the evidence establishes | What it does not establish |
| --- | --- | --- |
| Bot definition and named thread | The local browser report passes creation through the real Worker/D1, a fresh associated session, failed-rename recovery, successful rename, refresh, bot/default switching and a 390px overflow check. | Successful model inference, a saved bot revision being used by a real harness, or general multi-tenant isolation. |
| Approval and credentials | An independent run of the four suites below passes 43 tests. Legacy custom-profile `auto_approve` settings no longer dispatch HTTP/chat tasks without a pending approval; missing profiles fail explicitly. The egress and core-loop suites check scoped credentials and pre-approval non-execution with fakes. | A live container startup/egress capture or production approval identity verification. An approved bounded subagent plan is separate from arbitrary new work. |
| Coding and review loop | The existing browser harness passes its mock GitHub/synthetic execution assertions, including findings rendered in the dashboard. | A real clone, model call, diff, PR, review comment or container. Its approval action uses the API, not an Approve-button click. |
| Public API isolation | Source and focused tests show explicit bearer credentials retain their org/scopes; grouped v1 operations are gated before dispatch; API-key calls to shared runtime stores fail with `501 tenant_runtime_unavailable`. | A completed organization-to-runtime-storage model. A deliberate refusal must not be described as working tenant runtime support. |
| Thread/run identity | Custom agents are bot definitions; named web sessions are persistent per-user conversations; coding runs are executions. The compatibility v1 thread surface still projects runs, including actual child lineage. | One canonical conversation registry shared by every UI and v1 operation, full transcripts, compaction, conversation archive/restore or Overlay's main-thread policy. |
| Frontend accessibility | The exercised local form has labels/errors and fits one phone-width viewport. Focused component tests cover particular states. | Complete keyboard traversal/focus restoration, screen-reader output, reduced-motion behavior, zoom/reflow or an accessibility audit of all views. |
| Build and deployment | Local builds, type checks and a Worker bundle dry run can establish development/package compatibility for their exact revision and options. | A passing hosted CI run, image startup, deployment, migration/rollback, backup recovery or live operational SLOs. The environment draft and its publication are separate from deploying Shiba. |

Independent check executed from `/workspace/shiba`, after initializing the
installed tools with `source /workspace/.tools/shiba-env.sh`:

```sh
pnpm -C apps/backend exec vitest run \
  test/custom-agent-approval-gate.test.ts \
  test/tradeoff-contracts.test.ts \
  test/codex-subscription.test.ts \
  test/phase1-core-loop.integration.test.ts
```

Result: **4 files passed, 43 tests passed, 0 failed, 0 skipped**. These are
repository tests with mocked external boundaries. The captured output is
`/tmp/shiba-acceptance-invariants.log` in the current machine.

## Release gates

| Priority | Required acceptance before claiming the capability | Remaining action / boundary |
| --- | --- | --- |
| P0 | Each fresh task freezes its effective bot instructions, model/connection, repository and execution options; no sandbox starts before the required approval. Cancellation settles the entire descendant tree and stale callbacks cannot revive it. | Preserve the new approval/cancellation regressions in the combined gate. Exercise a real approved run, rejection and cancellation before a live-execution claim; never reintroduce profile-based automatic approval. |
| P0 before unrelated multi-tenant use | Every runtime, transcript, event, automation, file, credential and memory query has an explicit owner/org policy, enforced server-side with negative cross-user/org tests. | Runtime/event/automation stores and the account-shared memory contract are not a complete unrelated-tenant model. Keep API-key runtime access closed until consistent principal-to-store/session routing, migrations and vector namespaces exist. Do not silently change intentionally shared data into an ad hoc route filter. |
| P0 before public deployment | A configured production identity proves the caller, unauthenticated origins cannot reach protected APIs, and direct-origin/header-spoof paths fail closed. | Configure and verify `ACCESS_AUD` for cryptographic Cloudflare Access identity, or the supported built-in session lane. `REQUIRE_ACCESS` without an audience still relies on a trusted upstream identity-header boundary; it is not equivalent to validating an Access JWT. Live SSO/cookie acceptance remains unrun. |
| P0 before a production-ready label | The final changed revision passes required checks, a representative configured coding loop, safe migration/rollback and restart/recovery acceptance with observable failures. | Local tests and a saved environment draft do not prove these release operations. No production deployment, merge or publication was performed by this audit. |
| P1 | A thread's bot association is validated server-side on create/update, cannot bind another org's/deleted bot, and cannot silently fall back during execution. Persisted chat and defaults survive navigation/reload without stale response contamination. | Server association and frontend history/defaults work must be included in the final combined unit/API/browser gate. An empty-thread browser pass alone does not prove persisted chat messages or provider streams. |
| P1 | One supported provider completes sign-in, renewal/revocation, streaming, tool results, failure and reconnect using the approved frozen route. Unsupported/disabled providers fail explicitly. | Requires configured accounts and authorized external testing. A CLI in an image, a dropdown option or a configured-secret indicator is insufficient. |
| P1 | Accepted webhook batches survive transient queue failure/restart, replay creates no duplicate side effect, and pending work has bounded resource use and visible backpressure. | Include the new retry/bounds regressions in the final gate; then verify the actual scheduled Worker path. Pure matching/scheduler tests do not establish deployed trigger delivery. |
| P1 | Bot/thread browser regressions run automatically, retain traces/read-backs and leave only their own fixture IDs eligible for cleanup. | The CI integration must actually invoke the new journey and upload its artifacts. The final combined browser result, rather than the existence of a workflow step, is the acceptance evidence. |
| P1 | Keyboard-only and assistive-technology use complete bot creation, thread selection, rename, failure recovery and approval without lost focus or hidden errors. | Add real browser keyboard/focus and representative screen-reader checks; the 390px overflow assertion covers only layout overflow. |
| P1 | Usage views distinguish measured zero from unavailable model/VM usage; any advertised hard limit is enforced before chargeable dispatch. | `USAGE_BUDGET_USD` is advisory. `v1/billing.ts` still maps absent model cost/token data to zero in several fields; VM cost explicitly reports unavailable. Keep budget and provenance claims accurate. |
| P2 | Add conversation archive/restore, durable workspace skills, optional file ingestion/retrieval and richer project organization only with explicit retention, ownership and failure semantics. | Session deletion/teardown is not an archive. Browser-local skill/repository libraries are not cross-device workspace storage. Inbound Shiba MCP serving is not arbitrary upstream MCP registration. |

These priorities apply to the capability being released. A missing unrelated
multi-tenant or document-library feature does not prevent the selected local,
account-owned development workflow from being usable.

## Configuration and external prerequisites

The default local API/dashboard workflow needs no production credentials.
Real coding execution needs the selected sandbox provider and a usable supported
model connection, with Git access scoped to the approved repository. Provider
OAuth and live integrations need their own configured callbacks/permissions.
Check existing bindings first and enter missing credentials through environment
settings; never put values in audit reports, setup scripts, traces or chat.

Cloudflare Vectorize/Workers AI, remote object storage, browser/computer services,
scheduled cloud delivery and real provider/GitHub operations have separate live
acceptance requirements. Payments and customer subscriptions are outside the
current self-hosted product scope. No live payments or external messaging should
be used merely to make a test appear complete.

## Patterns to preserve and avoid

Keep Shiba's Worker/Durable Object/D1 architecture, mandatory approvals,
repository-scoped Git egress, provider-specific credential boundary and explicit
unsupported-capability responses. Adapt Overlay's separation of bot definition,
conversation identity and run identity, server ownership checks and durable
execution state where useful.

Do not transplant Overlay's vendors, visual identity, broad tool permissions,
SaaS billing, connector catalog or document platform just to match a checklist.
At the inspected Overlay revision, external-agent/control-plane/remote-run/cloud
environment features are default-disabled; their source presence is not a
production reference result. Full visual or feature equality is not established
by this audit or by the local passing checks.
