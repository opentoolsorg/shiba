# Agent tradeoffs

These are load-bearing rules for this repo. A change that breaks one of them is wrong even if the tests that used to pass still pass. Each rule names the test that locks it.

## Credentials never enter the container

Model and subscription tokens are attached in the Worker egress proxy. The sandbox sees a placeholder (`shiba-egress-placeholder` or the harness dummy key), never the real bearer, refresh token, or `auth.json`.

Locked by `apps/backend/test/tradeoff-contracts.test.ts` ("credentials never enter the container") and `apps/backend/test/codex-subscription.test.ts` (egress attaches the plan token).

## Subscription lanes do not need AI_GATEWAY_TOKEN

A connected ChatGPT plan (`codex-subscription`) and an opted-in Claude setup-token (`claude-subscription`) run without `AI_GATEWAY_TOKEN`. A paired local daemon running Claude Code also does not need it. Gemini, Grok, and OpenCode still use the gateway; the Providers card says so instead of pretending otherwise.

Locked by `apps/backend/test/setup-doctor.test.ts` (preflight without the gateway token) and `apps/backend/test/acp-providers.test.ts` (subscription test does not demand the gateway token).

## Approval is required before any sandbox starts

Queueing a task mints an approval. The harness does not run, and no sandbox is created, until that approval is granted.

Locked by `apps/backend/test/phase1-core-loop.integration.test.ts` ("does not start work before approval").

## The GitHub token is scoped to the approved repo

Until a run is approved for one repository path, GitHub egress is denied. After approval, requests outside that path are refused. The token is not a general GitHub credential for repository code.

Locked by `apps/backend/test/tradeoff-contracts.test.ts` ("refuses GitHub traffic until a repo scope is approved").

## UI polish skill

For Shiba web, docs, or dashboard visual-polish requests, read
`.agents/skills/shiba-ui-polish/SKILL.md` and apply its UI Skills guidance
alongside the relevant framework skill. Keep the requested scope and
existing product contracts.
