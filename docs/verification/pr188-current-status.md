# PR 188 current completion index

This is the current scope index; older dated reports retain their historical
results. The code checkpoint for the Meta/key-routing addition is `ce341d6`.
Preview work is paused. No production deployment, merge, real provider request,
Slack send, paid inference or credential creation is included in this evidence.
All remaining isolated work is preserved in a [clearly unfinished source
snapshot](../unfinished/README.md); it is not applied to the runtime.

| Requested work | Implemented and tested boundary | Remaining acceptance or product gap |
| --- | --- | --- |
| Ephemeral workspaces and artifacts | Approved repository-free work, bounded private ZIP export, scoped downloads; immutable Git publication and revision checks. | ZIP is bounded in memory, rather than streaming compression. Deployed R2/signing/lifecycle acceptance is unverified. |
| Bounded specialists | Depth/role/policy/input-bound dispatch, finite concurrency, read-only Explorer/Reviewer and separately human-approved Fixer. | Real Cloudflare facet execution/eviction and provider acceptance remain unverified. |
| Multiplayer and shared context | Authenticated attributed rooms, presence/cursors, selected versioned sources, explicit membership and revocation; private memory stays private. | Fixture/local proof does not establish installed two-human cloud behavior or reference-product parity. |
| Terminal and replacement recovery | Bounded same-container source journal and reattachment, durable acknowledged redacted frames, gap signals, staged/untracked diffs and verified retained-output export. A local workerd/D1/TCP drill recovered 42 acknowledged frames over four runtimes with no replacement command launch. | Destroyed process memory, uncommitted files, unacknowledged tails and over-limit frames are not recovered. Cloud transport/eviction acceptance remains unverified. |
| Slack coordination | Signed, expiring, action-bound human approvals; durable next-turn buffering; managed installation generations; two-surface identity consent; private self-authored drafts with explicit native room adoption. | Installed Slack/OAuth/edits/deletes/completion acceptance is unverified. Native agent-session status is not implemented. Adoption is not autonomous execution. |
| Founder automatic reads and digests | Exact consented Figma/Linear/GitHub reads, separate Figma comments, fixed Google Ads query, native-owner Stripe reports, and separately reviewed OAuth-report Slack delivery. | Stripe/Meta reports do not inherit the OAuth-report disclosure grant. Automatic cross-source reporting and those new delivery families are unfinished. |
| Meta and per-source keys | Default-off private Meta account verification and bounded fixed daily insights; native session and source fences; explicit setup panel. Google Ads keys are selected by exact workspace/connection and pinned in the human-reviewed contract, independent of other read keys. | Requires configured private keys, migrations, owned accounts, operator-reviewed deployment and live provider acceptance. Verification does not prove provider tokens lack other permissions. |
| Financial reconciliation | Stripe reports expose qualified captured-page arithmetic by currency. | HubSpot MCP audience/schema/native capture adapter is missing. An isolated receipt composer and UI use synthetic authority and are not promoted or represented as operational reconciliation. |
| Team-funded models | Separately sponsored interactive text, configured GLM/Llama adapters, bounded expiring model quotes, atomic per-grant/requester/workspace reservations; uncertain usage retains debit. | Not arbitrary CLI/provider billing, an invoice cap, purchases, payroll or transfers. Live billing/quota behavior is unverified. |
| Shared computer | Approved offline machine, fixed lease/resources, named viewers/controllers, exclusive human control, bounded sampled refresh and fixed input. Earlier local Docker and CI checks exercised real display/input/capture/cleanup. | Not internet access or live video. Public package fetch failures can block a fresh image build. |
| Employees, apps, MCP and skills | Optional role setup, provider/runtime choices, reviewed source pins, real OpenConnector/MCP/skill runtime paths, scoped grants and honest unavailable states. | Catalog presence is not a connected account. Actual OAuth/provider compatibility requires an authorized configured environment. |

## Current checks

- `42b4370`: local full typecheck/SDK synchronization passed. Exact-head
  [CI #526](https://github.com/opentoolsorg/shiba/actions/runs/42018255417)
  passed 7,110 workspace tests with three opt-in live tests skipped, 51 daemon
  checks, five built-site checks, seven deployment checks, builds and fixture
  browser flows. [Desktop #99](https://github.com/opentoolsorg/shiba/actions/runs/42018255244)
  is separate. Its computer job failed
  fetching immutable Debian packages with HTTP 503; GitHub refused its retry while
  the parent workflow was running. This is not a successful image result.
- Meta/key-routing addition: 55 focused backend and 16 frontend checks passed,
  including independent key/session races and actual setup-panel navigation;
  configuration parity and development-variable checks passed. These tests use
  synthetic identity and intercepted provider responses.
- The original v3 aggregate found 40 failures. The reviewed hotfix and 77-case
  focused gate addressed the renderer, session and migration findings; isolated
  failure-file checks and the subsequent complete `42b4370` CI suite passed.
  Those results do not certify a later head's added code.
- [Inline review follow-up](pr188-review-followup-20261105.md) maps seven existing
  threads to source and regression evidence. They remain unresolved on GitHub;
  scoped review is not whole-PR review approval. Detailed main-protection lookup
  was denied HTTP 403 by the integration, so unavailable requirements are not
  inferred or bypassed.

See [phase acceptance](../control-plane-acceptance.md),
[live acceptance scenarios](../control-plane-live-acceptance.md),
[v3 product evidence](four-priorities-v3-20261105.md),
[Meta contract](../founder-meta-read-design.md) and
[read-key setup](../founder-automatic-reads.md).
