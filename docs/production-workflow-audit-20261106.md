# Dogfood production and production-build workflow audit — 2026-11-06

## Verdict

Shiba is not yet an end-to-end Overlay-equivalent browser/computer product.
Read-only Cloudflare MCP inspection and public production browser checks found
configuration gaps. The current local production build passes browser journeys
with explicitly synthetic execution. No production configuration, deployment,
account, Slack message, or paid runtime was changed by this audit.

Source inspected: `293d895346788a2c84d45009c3612708fbe3102f` plus the
coordinator's uncommitted multiplayer/Slack frontend changes. These changes are
not established as deployed by the checks below.

## Live Cloudflare evidence

Target: `shiba-ai-coworker-dogfood.opentoolsorg.workers.dev`.
Cloudflare MCP read the script settings and active version resources. The latest
100% deployment was uploaded on November 6 at 05:34:11 UTC. Both reads agree:

- Present: `Sandbox`, `CodingOrchestrator`, `OpenCodeAgent`, `AGENT_AUDIT`,
  `ASSETS`, and `BROWSER`.
- Missing: `ConversationRoom`, `ComputerSession`, `LocalDispatch`, `ChatGptAuth`,
  `UserProviderOAuth`, `ARTIFACTS`, and `INTERNAL_SIGNING_KEY`.
- No `SHIBA_SHARED_COMPUTER` enable flag or `SHIBA_SHARED_COMPUTER_IMAGE` binding.
- No `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, or
  `SLACK_INSTALLATION_KEYRING` binding.
- Default route: `RUNTIME=sandbox`, `AGENT_HARNESS=opencode`, coding model
  `google/gemini-3.5-flash-lite`. No `AI_GATEWAY_TOKEN` binding.

These are binding-presence checks, not reads of secret values or customer rows.
The current source requires the gateway token for the default cloud BYOK lane
(`apps/backend/src/run-preflight.ts:84–95`); subscription/local exceptions do
not establish that this deployed default can execute. Deployed per-user model
connections and signed-in execution were not inspected.

`BROWSER` is Workers Browser Rendering for headless preview captures, not proof
of a shared interactive browser or an agent desktop stream.

## Live public browser and HTTP checks

- `/app/` and a canonical `/threads/?workspace=…&room=…` URL return HTML, HTTP 200.
- A fresh browser settles at native sign-in. The team invitation form opens and
  returns to sign-in; an empty form cannot create an account. No account created.
- `/api/whoami`, `/api/setup/status`, `/api/custom-agents`, `/api/runs`, and
  `/api/team-workspaces` return JSON HTTP 401 without a session.
- Browser error collection was empty after navigating the sign-in/invitation UI.

This proves public availability and unauthenticated denial, not signed-in room,
computer, bot, model, or Slack operation. An authorized native test session and
two consenting workspace members are still needed for production acceptance.
No auth bypass, bootstrap token, fabricated cookie, or customer data was used.

## Why computers and bots differ from Overlay

The shared-computer entry is inside a team room's Work surface, behind
**Open shared computer** (`CollaborationView.tsx:1590`). Its contract is an
**offline human desktop**, not online browsing or agent computer use. It requires
an approved pinned image, dedicated Container/DO binding, signing key, native
room identities, separate funding/start consent and controller lease.
`docs/shared-computer-online-boundary.md` records why internet and agent control
remain blocked. It must not be enabled by merely flipping a flag.

Bot creation persists a profile; Launch opens a conversation. Neither allocates
a computer nor executes a task. Work submission requires a valid target, model
preflight and separate human approval. Coding live-work visibility is
terminal/diff/status, not a bot's graphical desktop. `RUNTIME=computer` remains
explicitly disabled (`apps/backend/src/runtime.ts`, `COMPUTER_PREVIEW_MESSAGE`).

## Fresh local production-build proof

`pnpm build` and `pnpm test:built` passed (five built-artifact tests).
The repository's existing `verify-shiba` CI runner then served those built assets
through a real local Worker and migrated local D1 on port 8790. It used the
example configuration, mock GitHub, disabled containers and a guarded synthetic
executor; it made no real provider, Slack, GitHub publication or container call.

- Core-loop browser/handler assertions passed: submit, pending approval, API human
  approval, synthetic completion, visible/persisted review findings and mock PR.
- Bot thread journey: **10/10 checks passed**, including creation, launch, rename
  failure/retry, refresh persistence, default-session isolation and 390px layout.
- Configured bot lifecycle: **11/11 checks passed**, including composer submission,
  failed-submit draft recovery, command reuse, frozen profile version, explicit
  browser approval, synthetic result, history, archive and restore.
- Created fixture sessions/profiles were cleaned with HTTP 200; local runner
  stopped its own services. Browser traces remain private.

Evidence: `.verify/agent-threads/result.json`,
`.verify/agent-lifecycle/result.json`, screenshots in those directories, and
`/tmp/shiba-prodmode-e2e/evidence/ci-local-20261106T080406Z`.
These are local production-build results, **not live production E2E success**.

Independent focused audits also passed 33 frontend and 56 backend computer cases,
and 113 bot-related cases. They inspected source and fixtures, not production.

## Full-suite baseline and remaining gates

The earlier completed root run passed all 1,533 frontend and 202 desktop tests.
Backend: 5,898 passed, one failed, three skipped, plus an unhandled rejection.
The failed `phase1-core-loop.integration.test.ts` assertion expects HTTP 400 for
an invalid-input matrix containing local execution without dashboard authority;
current source returns 403. The unhandled rejection originated in
`local-daemon-deliverables.test.ts:208`, parsing an empty request as JSON.
No assertions were weakened. The full root gate is **not green**.

PR #196 later updated the direct-intake matrix to expect 403 for local execution
without dashboard authority. The 400-versus-403 assertion mismatch is resolved;
the full root gate above remains a historical result, not a current rerun.

Next gates: resolve deployment/source drift through reviewed deployment; provision
secure native test sessions; prove two-account rooms/presence/removal; verify an
approved real model run and live-work transport; configure and authorize a real
Slack exact-thread intake/review/delivery journey. Online bot-driven browser use
requires its separate implementation/security design, not just deployment repair.
