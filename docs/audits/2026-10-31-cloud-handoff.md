# Cloud continuation handoff — incomplete validation

The user withdrew permission for local desktop tests because they disrupted their work. Remaining verification must run on the cloud receiver `01a19138-6c02-7426-9f3d-5218a828d0d1`. Do not launch tests, browsers, Electron or fixture Workers on the user's Mac. Only owned test children were stopped; no user app was closed.

## Destination and preserved refs

Existing destination remains PR163, `cursor/desktop-local-path-wiring-9e7a`. It was open/unmerged at `c8ca2786e51ae338c94f3b82dff15e3791b8f759`; main was `0c4ccc480c4ddbccfae5e384f37d90c80a21ab45`. Fetch current metadata before any eventual push. If PR163 has closed/merged, ask the parent for destination. No new PR, squash, force push, merge, deployment, preview/CI label, PR-body change, credentials or live/billable external actions are authorized here. Cloudflare account/hostname selection remains unanswered.

Every transfer ref below preserves individual commits. New assistant author/committer: `princepal9120 <107296821+princepal9120@users.noreply.github.com>`.

| Remote transfer branch | Snapshot / use |
| --- | --- |
| `princepal/cloud-handoff-20261031-01a19138` | Integration through `fb3691464ed3d74835845157a1a0d4bf00e8f23c` plus this handoff document. **Not fully validated.** Keeps all existing PR163/main history. |
| `princepal/cloud-ui-20261031-01a19138` | `30c4d972b0f191fda05452c57359498605937ac7`: cherry-pick **only 30c4d97** onto integration; its earlier UI/goal/context prerequisites already have equivalent integrated commits. Final UI guards/fixture fixes are unverified. |
| `princepal/cloud-mcp-20261031-01a19138` | `90cf62a4ffc558e10ee9a81a78f6011701f37b9b`: cherry-pick preserved bridge **4709896**, then **90cf62a** only; exclude duplicate local goal dependencies/merges. Root orchestrator wiring still required. |
| `princepal/cloud-native-20261031-01a19138` | `7590edaabcb44066e286dfd931d0bb71f5e55395`: cherry-pick **only 7590eda** for WIP output extension; base native `ea45571` already integrated as `c58e5e0`, helper `5f5f96c/10066aa` as `ac01b92/4917556`. |
| `princepal/cloud-context-20261031-01a19138` | `63fc9054abbd8c97e4e058c57438e93440cd01f7`: helper/source DTO export already integrated as `b9876d6`; do not duplicate. Origin fixture `b62dbe5` already integrated as `2b28a00`. |
| `princepal/cloud-projects-20261031-01a19138` | `1c57687cef70370ccb311c686f9bdac1db231b2b`: isolated WIP acceptance/project edit/archive CAS. **Do not merge blindly**: consumers/UI and structured source authority remain unfinished. |

The root integration includes goal prerequisites `6c437da/86c1bcf`, rebased goal core/followup `a851a4c/44258e6`, GET redirect proof `b29a0d4`, recovery `fc87f61`, conversational UI/stale fix `60d2b04/3e3d729`, managed helper `b9876d6`, native base `c58e5e0`, and new review fixes `5bb81cf/fb36914`. No final aggregate was run on this combined tree.

## Current review gates

The original 17 PR162 findings are tracked in `docs/audits/2026-10-31-pr162-findings-pr163.md` and were delivered in c8ca278. Three later PR163 findings are additional:

- [Draft ownership](https://github.com/opentoolsorg/shiba/pull/163#discussion_r4430803384): integration `5bb81cf` resolves organization from exact owned stored session through `employee-app-session.ts`, independent of latest composer metadata/current tool grants. Actual orchestrator list/download/review tests after grant revocation cover absent/forged/malformed composer, non-default saved workspace, wrong owner/session and missing/deleting/duplicate registry. 24 focused tests and source/test types passed; Sol source review clear.
- [App send recovery](https://github.com/opentoolsorg/shiba/pull/163#discussion_r4430803386): UI transfer 30c4d97 resets `submitFailed`, checks callback-style failure after resolved send, and restores scoped text. Late guard protects a newly selected goal id/version even when canonical text is identical. **Final guard and fixture corrections were not rerun.** Cloud must test callback-only failure, thrown failure, success, newer text/session and same-text newer goal selection.
- [Explicit deployment account](https://github.com/opentoolsorg/shiba/pull/163#discussion_r4430803380): integration `fb36914` separates optional stored-profile API token from required 32 lowercase hexadecimal account ID in `.env.example` and `.env.schema`. Existing deployment preflight tests and isolated actual Varlock missing/uppercase/short/nonhex/valid cases passed. No account was provisioned.

Do not resolve review threads or post responses without separate authorization.

## Evidence and limits

- Last fully checked published source: `096fb396add5bab079f8cec3cb862fec6f89c9e7`; delivery c8ca278 adds only report/evidence. 3,931 package tests passed, three intentional live-provider skips; 16 deterministic acceptance journeys, nine Chromium checkpoints, eight prior native checks. These counts do **not** validate subsequent transfer code.
- Goal core/followup: author reported 322 focused tests and full source/test types passing; Sol reviewed canonical goal/profile/source binding and final dispatch fences. Exact accepted current-goal output activates without inventing ACP/OAuth readiness.
- Stale-goal UI base `0fc574c` (integration 3e3d729): 374 frontend tests/types and 13 actual Chromium/local Worker/DO/D1/auth checkpoints passed. The old websocket counter searched the wrong protocol string; disabled button and zero run POST/reload proof were valid, but the old app-frame-zero assertion was vacuous. UI30 corrects the protocol counters; verify them in cloud.
- UI30 extension: earlier full frontend 377 passed before final prepared-context/ref guard edits. Latest actual browser run passed 14 checkpoints, including callback failure/newer text, then **failed before managed-context proof** at a second-owner page locator. Fixture wait and a test matcher were corrected without rerun. There is no complete green source→goal→artifact browser result yet.
- Managed helper: seven verifier/helper tests, 49 backend tests, source/frontend types/lint passed. Helper-unit stubs are not browser proof. Real second authenticated owner must be used for wrong-owner checks; anonymous 401 is different. Download hash uses raw bytes; semantic citation validation remains explicitly false.
- Native base ea45571: author reported actual Electron + current React + isolated Worker restart case 1/1 passed, 16.49s. It proves saved goal, unsent answer, prepared ID/version, named thread and Work selection across client restarts. It is not a Worker restart or provider execution test.
- Native7590 extension: last run reached exact goal queued approval, then failed a strict duplicate main/toast selector. Selector narrowed, **untested** after local testing was stopped. Remaining claim/result/R2/review/final restart must run in cloud. It uses supported repository-target local deterministic adapter, not repository-free artifact-workspace execution. Production correctly rejects artifact-workspace+local; never relax that guard for fixtures or use a dummy repo.
- MCP90: author reported 84 focused backend tests, 19 frontend tests and source/test/frontend types/lint passing, code/architecture reviews clear. Actual tool/D1/R2 paths use fake HTTPS MCP/provider responses; no live model/Gmail/Sandbox. Late selected-context session switch/deletion after R2 await rejects metadata commit; no remote-blob rollback is claimed.
- Projects1c: 24 existing/new owner store/route tests and backend source types passed before local test withdrawal. Acceptance migration, edit/archive CAS and 409 currentProject are present. Full test types were blocked by old onboarding test typing on that lane's baseline (already corrected in integration). Project editor CAS consumers, acceptance in frozen project prompts, stable project/task/output links, pins, and dispatch authority rechecks are still missing.

## Required integration work before cloud aggregate

1. Inspect every branch/diff and preserve history. Integrate UI30 and MCP470+90 carefully, retaining root-owned session authority helper. Identical helper files should deduplicate, not replace current full modules with old versions.
2. Complete MCP orchestrator hooks: import `employeeCanRetainDraft`; app-only active tools expose catalog/call only when current context has allowed actions, `employee_context_read` only for current prepared goal, and retain only for goal or `employeeCanRetainDraft(context)`. Keep goal resolver errors fail-closed. Exclude context_read in both non-app no-profile/legacy filters and ordinary managed turns without a current goal. Do not widen Sandbox/CodeMode or principal scopes. Optional skill pins represent actual applied instructions only; default [] is truthful.
3. Verify UI prepared-context exception allows a valid current saved goal with a real owned employee/session/socket, even when connector scopes are empty/undefined; unprepared/stale input remains blocked. The client flag grants no server authority.
4. Run managed upload/selection/goal snapshot/approval/draft/review/activation browser proof and native restart cases, plus all original review regressions and the three new cases. Use deterministic adapters; report live-provider journeys blocked.
5. Freeze a source SHA, then run source/test types, lint/CI, build/docs/env parity, full package/backend/frontend tests, local-in-cloud self-host smoke and acceptance. Do not claim a Linux/cloud pass proves macOS-specific behavior.
6. Fetch PR163 current head/main, reconcile concurrent changes without force/squash, and push only when the cloud coordinator confirms a coherent tested checkpoint. No new PR or merge.

Cloud may test Linux Electron with a supported display fixture and shared React/Worker behavior. macOS tray/notification click-through, Apple signing/notarization/Gatekeeper, Keychain/subscription-login behavior, protocol/login-item OS effects and real Access-fronted deployment remain unsupported/unverified without an authorized suitable Mac. Do not return these tests to the user's desktop.

## Remaining original roadmap

Conversational source/configure return and repository-free supplied-facts drafting still need complete integrated evidence. Projects need structured authority/links/pins and UI CAS; artifacts need an authorized immutable collection/read model; reconnect should compose existing spine dedupe/cursors/resync; budgets need serialized reservation/settlement; hosted sharing needs real tenant membership/ACL lifecycle before enabling shared visibility. Rich binary artifact handlers, repeatable-work policy and operational deletion/retention recovery remain incomplete. Keep existing DO/D1 authority; no compulsory framework rewrite. Marketing stays deferred; Reason remains upstream OSS only.

Private original plan inputs remain in the user's Library/parent context; do not publish those private source documents into this repository as part of transfer.
