# PR 188: six-feature acceptance checkpoint

**Not all requested features are complete.** This report describes a bounded
hardening increment, not a deployed release. The baseline head rechecked on
November 5 is `d424d0385ae632fda3f802356f845301bf1774b9`, branch
`feat/prince-multi-agent-control-plane`. This increment needs its own exact-head
CI and Desktop acceptance; baseline success does not establish that acceptance.
Older completion reports describe their own narrower checkpoints.

## Feature status and evidence

| Requested area | Local implementation evidence | Remaining boundary |
| --- | --- | --- |
| Authorized Slack coworker execution — partial | `slack-coworker-routes.ts` adds an explicitly reviewed draft submission into ordinary collaboration approval. `slack-coworker-store.ts` uses one guarded receipt claim per draft and current identity, intake and installation fences. `collaboration-context.ts` rechecks the source fence before context access/queue/dispatch. Slack fixture suites cover scope overrides, one-shot claims and unknown-outcome retention. | Installing Slack, adopting text and queueing are not execution approval. Product UI still stages text for ordinary native review. No installed Slack/OAuth, real approval-to-provider execution or deployed transport acceptance was performed. |
| Shared-computer access — partial/offline | Existing offline human-only desktop contract remains unchanged; boundary disclosures and strict-field fixtures reinforce it. See [network boundary](../shared-computer-online-boundary.md). | No online browsing, authenticated website use, live video or agent control was enabled. Hostname checks alone do not prevent DNS rebinding. The build-only Debian cache is not a runtime importer. |
| Team funding — partial/text only | `team-model-adapters.ts` validates fixed text-only operations and rejects tool/audio/image responses. `team-model-runtime.ts` retains uncertain reservations; `team-model-store.ts` rechecks approved input. Fixtures cover unsupported output, usage uncertainty and UTF-8 bounds. | No purchases, payroll, transfers, arbitrary providers or non-text funded operation. No real payment or paid inference occurred. Preparation is not activation. |
| Recovery — partial | `run-output-archive-store.ts` checks bounded retained-page counts, contiguous ordinals, per-record chains and final checkpoints. Corruption fixtures fail closed without ACK advancement or replacement START. | Integrity checks detect corruption relative to stored checkpoints, not an attacker rewriting both data and hashes. No destroyed process memory, unacknowledged tail, unsaved files or file-snapshot restoration; never a zero-loss guarantee. |
| Native Claude login and repo-free local artifacts — partial | `claude-login.ts` fails closed rather than mounting credentials. Local runtime/shared envelope/daemon/export changes accept only explicit approved UTF-8 deliverables: at most eight files, 16 KiB each, 64 KiB total. Actual-daemon fixtures exercise no-clone/no-Git capture and exclude unrequested files. | Native cloud Claude login remains unavailable. The orchestrator still rejects local artifact intake and forces artifact work to sandbox; `supported-task-routes.ts` also blocks it. The adapter/daemon increment is therefore not a completed product journey. |
| HubSpot–Stripe reports — partial | `founder-reconciliation-rolling.ts` derives reviewed windows from captured data, separates currencies and uses exact integer totals. Ambiguous duplicate keys remain unassigned even when dated. Route tests recheck owner/session/source/report/executor proofs, including revocation after an earlier positive proof. | Snapshot invoice comparison is not MRR, churn, payment-date revenue or complete ledger reconciliation. No new provider calls, refreshed sources or live integration acceptance. |

## Verification

Parent-run focused checks on this working increment:

- Backend: **285 tests passed across 12 suites**, serially. This includes all 25
  retained-output archive cases; the existing 2,049-frame case passed in this run
  without changing its timeout. Earlier agent timeout failures are not concealed.
- Frontend: **34 tests passed across four changed component suites**.
- Personal native daemon: **51 tests passed**, no live provider use.
- Real collaboration-context revocation regression: **four tests passed** in the
  agent run and independently in the parent run. Queueability, frozen dispatch
  and human-assignment reads fail closed after Slack intake revocation; valid
  non-Slack handoffs remain unaffected. The test-project typecheck also passed.
- Root typecheck, lint, import lint, `check:ci`, build, five built-site tests,
  docs checks and deployment-configuration checks passed. Lint emits existing warnings;
  passing does not mean warning-free.
- The first complete workspace run **failed**: eight packages passed, while
  backend reported 5,723 passed, four failed and 70 skipped tests, including a
  60-second cold-import hook failure. Three assertion failures expected the now
  disabled native Claude lane in runnable catalogs. Tests now explicitly retain
  its reserved wire ID while requiring no runtime/catalog entry and no approval
  on intake. The serial four-suite rerun passed **142 tests**, including all 67
  runtime cases, without raising timeouts. The live-diff failure independently
  reproduced a runtime filesystem behavior: `O_DIRECTORY | O_NOFOLLOW` followed
  directory symlinks. Descriptor-anchored opens now retain `O_NOFOLLOW` and use
  nonblocking open plus `fstat` directory validation instead. All **25 live-diff
  tests passed** in both agent and parent runs, including symlinks, regular-file
  and FIFO substitutions and existing anchored-read race checks. A fresh full
  workspace rerun is in progress. Native Electron/macOS and deployed acceptance
  remain unverified for this increment; desktop unit tests passed in the first run.
- `build:validate` is a GitHub workflow label, **not a package script**. Running
  `pnpm build:validate` reports command not found; the actual package/CI gates
  must be used instead.

The parent reran the offline component browser fixture in Chromium
140.0.7339.186: eight interaction checks, fourteen screenshots, no page errors
and no external requests. Agent viewport checks additionally covered twelve
viewport/theme overflow states. Representative full-size evidence and the
contact sheet were inspected. These use actual React components/styles but
`file://` and in-memory fixtures: **not authenticated dashboard routing, backend
integration, desktop execution or live-service end-to-end proof**.

- [Slack uncertain action](pr188-boundaries-20261105-slack-uncertain-390-dark.png)
- [Offline computer](pr188-boundaries-20261105-computer-ready-390-dark.png)
- [Funding preparation](pr188-boundaries-20261105-funding-prepared-390-dark.png)
- [Report definitions](pr188-boundaries-20261105-reports-ready-390-dark.png)

Published-head checks only (not proof of these working changes):

- [CI](https://github.com/opentoolsorg/shiba/actions/runs/42058909884): success.
- [Desktop](https://github.com/opentoolsorg/shiba/actions/runs/42058910174): success.
- Preview deploy/destroy jobs: skipped. The live preview remains paused.

## Security and review state

Fresh GitHub thread data reports **seven unresolved threads, six outdated**,
with no pagination remaining. The PR is open, `REVIEW_REQUIRED` and `BLOCKED`.
Source applicability and GitHub resolution are different: no thread was resolved
by this work.

| Thread | Source applicability from independent review |
| --- | --- |
| [4466157582](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157582) | Journal short-value redaction addressed in current source. |
| [4466157654](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157654) | Specialist JSON redaction addressed by redacting fields before serialization. |
| [4466157670](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157670) | Partially mitigated: new fragment-to-POST download links; legacy query links remain valid until expiry, with bearer sharing and no individual revocation limitations. |
| [4466157687](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157687) | Missing Slack bot-token handling addressed in current source. |
| [4466157696](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157696) | Capped terminal history addressed with offsets/epochs. |
| [4466157706](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157706) | Duplicate-tab identity addressed with browser locks. |
| [4466157714](https://github.com/opentoolsorg/shiba/pull/188#discussion_r4466157714) | Retry intent/frozen-target handling addressed in current source; thread is not outdated. |

The independent applicability pass reported 85 backend and 27 frontend tests
passing. Narrow read-only Slack audits found no concrete defect in claim
atomicity, strict schemas, origin/transport handling or retained uncertainty;
these are static findings, not production D1/interleaving proof. They identified
a missing real collaboration-path revocation regression; the new
`slack-coworker-collaboration-fence.test.ts` now covers the real exported context
boundaries, but does not establish a live route-to-provider journey. Downstream
cancellation/lease release was not established by those audits.
Unattended-automation wording in `apps/web/src/pages/index.astro` remains an
applicable concern. Deployed R2 lifecycle enforcement remains unverified.

## Owner decisions and acceptance still needed

1. **Computer:** choose a reviewed fixed public-document catalog/content-addressed
   snapshots versus arbitrary URLs. A bounded human-reviewed inert-text import
   can preserve offline isolation; arbitrary URLs require SSRF-safe transport.
   Neither import nor online browsing was added. Authenticated browsing and agent
   control need separate security contracts; the current offline Chromium
   `--no-sandbox`/root assumptions must not be reused as a hostile-web boundary.
2. **Funding:** approve an operation-specific result, metering and retention
   contract before any non-text adapter. A single synchronous embedding operation
   is a candidate, not implemented. Published model/input-limit ambiguity must be
   resolved; absent usage receipts require honest permanent reservation accounting,
   no automatic replay and no claim that cancellation refunded or stopped billing.
3. **Claude/artifacts:** choose the supported local/API route explicitly. Cloud
   native login needs a separately approved credential design; completing local
   artifacts needs queue/approval/UI integration, not merely adapter tests.
4. **Reporting:** agree metric definitions, invoice mapping, capture completeness,
   refresh/future consent and sharing scope. MRR/churn need additional justified
   data and definitions rather than relabeling invoice sums.
5. **Live acceptance:** explicitly authorize owned accounts and fixtures-to-live
   scenarios before testing Slack, Cloudflare or reporting services. This run
   does not authorize credentials, provider requests, purchases or paid inference.

## Recommendation

**Do not merge as a completed six-feature release.** Finish integration, exact-head
CI/desktop and review acceptance first. Merging to main triggers frontend
deployment separately from backend deployment; neither merge nor deployment is
authorized. Auto-merge is disabled for this task. No force-push, merge, deployment
or live-preview resume was performed.

Parallel reports were incorporated, but agent totals are not feature acceptance:
100 launches/completions were not verified, one supplied agent failed without a
usable result, and this run cannot switch to another subscription/provider.
The separate read-only acceptance thread also concluded incomplete; its code
review used older `main` (`1ee6c54`), so it is not independent verification of
this increment. Its owner-decision recommendations are consistent with the
boundaries above. Live acceptance does not authorize or require an early merge.
