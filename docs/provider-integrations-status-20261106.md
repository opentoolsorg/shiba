# Provider and channel integration status — 2026-11-06

Audit of whether each model harness and channel integration works end to end.
Base revision `293d895`. Static code reading plus local test runs only: no
deploys, no vendor or model calls, no secrets used.

**Nothing here is "live verified".** That label needs a recorded real call
against a real account, and none was made. The newest acceptance evidence
(`apps/backend/test/acceptance/evidence.latest.json`, 2026-10-31, revision
`0864286`) is `local-deterministic` with a fake executor, no live providers, and
its `live-sandbox-and-provider-execution` journey is `blocked`.

## Answer

No. Locally, every code path has passing fixture tests. On the dogfood Worker
the default path (OpenCode on the gateway) fails run preflight, and no
subscription lane, ACP lane or Slack path is enabled.

## Dogfood config used (from Cloudflare, as supplied)

`RUNTIME=sandbox`, `AGENT_HARNESS=opencode`,
`CODING_MODEL=google/gemini-3.5-flash-lite`. Absent: `AI_GATEWAY_TOKEN`, Slack
secrets, `INTERNAL_SIGNING_KEY`, and the `LocalDispatch`, `ChatGptAuth` and
`UserProviderOAuth` bindings. Bindings present in `wrangler.dogfood.jsonc`:
`Sandbox`, `Mailbox`, `ATTACHMENTS` (R2), `SEND_EMAIL`, `ModelConfig`,
`AGENT_AUDIT`. Worker secrets are not visible from the repo, so any secret not
listed is treated as **unknown**, not absent.

## Model harnesses

Code path: `apps/backend/src/harness/*.ts`, gates in `harness/index.ts`,
credential metadata in `harness/catalog.ts`, preflight in `run-preflight.ts`,
doctor in `setup-doctor.ts`.

| Provider | Code path | Tests passed | Local E2E | Needs config | Dogfood status |
| --- | --- | --- | --- | --- | --- |
| OpenCode (default) | `harness/opencode.ts` | opencode-agent, -input, -standin, -journal, harness*, setup-doctor: all pass | Fixture only (`phase1-core-loop`, fake executor) | `AI_GATEWAY_TOKEN` + gateway BYOK for google/anthropic/openai/xAI (`ai-gateway-byok`) | **Blocked.** Preflight throws "AI Gateway is not configured". Default `gemini-3.5-flash-lite` needs a google BYOK key that cannot be seen from here. |
| Claude Code (API key) | `harness/claude-code.ts` | harness-parity, harness-capabilities pass; no dedicated file | Fixture only | `AI_GATEWAY_TOKEN` (anthropic BYOK) | **Blocked** (gateway). Also runs on a paired local daemon without the token (needs `LocalDispatch`, absent). |
| Codex (API key) | `harness/codex.ts` | parity and capabilities pass | Fixture only | `AI_GATEWAY_TOKEN` (openai BYOK) | **Blocked** (gateway). |
| Grok / xAI | `harness/grok.ts` | parity and capabilities pass | Fixture only | `AI_GATEWAY_TOKEN` (xAI BYOK) | **Blocked** (gateway). |
| Pi | `harness/pi.ts` | parity and capabilities pass | Fixture only | `AI_GATEWAY_TOKEN` | **Blocked** (gateway). |
| Codex / ChatGPT subscription | `harness/codex-subscription.ts`, `codex-device-auth.ts`, `subscription-*.ts`, `provider-oauth/` | codex-subscription 26, chatgpt-siwc 10, chatgpt-sandbox-oauth 3, subscription-auth 17, -device-auth 3, -egress-scope 19: all pass | Fixture only | `SHIBA_CODEX_SUBSCRIPTION=1` or `MODEL_CREDENTIAL_KEY` (64 hex); `ChatGptAuth` DO for Sign in with ChatGPT; or `CODEX_SUBSCRIPTION_AUTH_JSON`. No `AI_GATEWAY_TOKEN` needed. | **Not enabled** by the known config. Sign-in cannot work without `ChatGptAuth`. Enabling it would need the flag plus a static auth secret, or `MODEL_CREDENTIAL_KEY` plus `ChatGptAuth`. |
| Claude subscription | `harness/claude-subscription.ts` | claude-subscription 21 pass | Fixture only | `SHIBA_CLAUDE_SUBSCRIPTION=1`, `CLAUDE_SUBSCRIPTION_TOKEN` (`worker-secret`). No gateway token. | **Not enabled** (flag not in vars; token unknown). The code logs a terms-of-service warning when enabled. |
| Claude `/login` | `harness/claude-login.ts` | covered by parity only | None | n/a | **Not sandbox-runnable.** `supportedRuntimes: []`. |
| Antigravity subscription (Gemini OAuth) | `harness/antigravity-subscription.ts` | antigravity-subscription 48 pass | Fixture only | `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1` or (`MODEL_CREDENTIAL_KEY` + `UserProviderOAuth`) (`oauth-signin`) | **Not enabled.** `UserProviderOAuth` absent. |
| Antigravity (API key) / Cursor (API key) | `harness/antigravity.ts`, `cursor.ts` | parity only | None | n/a | **Not runnable.** `supportedRuntimes: []`; registered for catalog and types only. |
| Cursor subscription | `harness/cursor-subscription.ts` | cursor-subscription 19 pass | Fixture only | `SHIBA_CURSOR_SUBSCRIPTION=1` or (`MODEL_CREDENTIAL_KEY` + `UserProviderOAuth`), `CURSOR_SUBSCRIPTION_TOKEN` | **Not enabled.** |
| ACP lanes (claude/codex/gemini/opencode-acp) | `harness/acp.ts` | acp* files, 90 tests: all pass | Fixture only | Same gateway token as the mirrored provider | **Blocked** (gateway). |
| ACP registry (`acp`) | `harness/acp-registry.ts` | acp-registry 27 pass | Fixture only | `ACP_REGISTRY_ALLOWLIST` (+ `ACP_REGISTRY_JSON`) | **Dark.** Not enabled. |

Cross-cutting: the Providers card, setup doctor and run preflight are covered by
`setup-doctor`, `setup-status`, `model-*`, `provider-*` and
`sandbox-selection-preflight`, all passing. The AGENTS.md contracts hold in the
tests: subscription lanes run without the gateway token, and credentials never
enter the container (`tradeoff-contracts`, `codex-subscription`).

Two things the doctor does not surface:

- With no `INTERNAL_SIGNING_KEY` and no `MODEL_CREDENTIAL_KEY`, child dispatch
  signing throws (`child-dispatch.ts`). Delegated or child runs are therefore
  unavailable on dogfood. Edge-identity signing silently becomes a no-op.
- `antigravity-subscription` reports `configured: null`, so the Providers card
  cannot show whether it is connected.

## Channels

| Channel | Code path | Tests passed | Local E2E | Needs config | Dogfood status |
| --- | --- | --- | --- | --- | --- |
| Slack | `slack-routes.ts`, `slack-events.ts`, `slack-installations*.ts` | 21 slack-* files, about 400 tests: all pass | Fixture journeys (`slack-web-room-continuity`; `slack-coworker-execution.integration`; workerd transport fixture, not re-run here) | `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APPROVERS`, `SLACK_CHANNEL_REPOS` (or installation secrets) | **Not configured.** No secrets, so events return 503 "set the SLACK_SIGNING_SECRET secret". |
| Discord | `discord.ts` | 31 pass | Unit only | `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPROVERS` | Unknown. Returns 503 if the key is unset; the secrets are not visible. |
| Telegram | `telegram.ts` | 28 pass | Unit only | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Unknown. Returns 503 if unset. |
| Email / mailbox | `email-handler.ts`, `mailbox-do.ts`, `mailbox-store.ts` | email-handler 18, email-approvals 50, mailbox-* 92: all pass | Fixture only | `Mailbox` DO, `ATTACHMENTS` R2, `SEND_EMAIL`, a registered address, Email Routing rule | Bindings are present. A registered address and the routing rule are unverified. Inbound is rejected as "Unknown address" until one is registered. |
| GitHub | `github*.ts`, `github-webhook-routes.ts` | github 16, webhook-dedupe 7, review-lane 6, project 9: all pass | Fixture (mock GitHub) | `GITHUB_TOKEN` or `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Unknown (secrets not visible). Webhook returns 503 if the secret is unset. |
| Linear | `linear/routes.ts` | Thin: `linear-webhook-config` has 1 test, plus `phase5-integrations` 7 | Unit only | `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY` or `LINEAR_OAUTH_ACCESS_TOKEN`, `LINEAR_DEFAULT_REPO_URL` | Unknown. Returns 503 if unconfigured. **Weakest test coverage of the channels.** |
| Generic webhook | `POST /api/trigger` (`trigger.ts`), Sentry (`sentry-webhook-routes.ts`) | trigger 7, sentry-webhook 10: all pass | Unit only | `TRIGGER_TOKEN` (32+ chars); `SENTRY_WEBHOOK_SECRET` | Unknown. Fails closed (503) without the token. |

## Test runs

| Run | Result |
| --- | --- |
| Harness, provider, doctor and preflight set (42 files) | 627 of 628 pass |
| Channel set (42 files) | 726 of 726 pass |
| `pnpm lint` | Exit 0, warnings only. The repo has no Makefile, so this is the lint gate. |

The one failure, `phase1-core-loop.integration.test.ts` "validates direct
execution-target intake before approval…", also fails on the base revision. The
request `{ executionTarget: artifact-workspace, runtime: "local" }` gets 403
`runtime "local" is admitted only through the dashboard` from the intake gate in
`agents/orchestrator.ts` (~L3187), but the test expects 400. It is not a provider
bug. Which side is right is a product decision (reject the combination as 400
first, or update the test), so it is not fixed here.

## Gaps that block a "yes"

1. Dogfood cannot run any gateway-backed harness without `AI_GATEWAY_TOKEN`
   (plus BYOK keys). This includes the default OpenCode lane.
2. No subscription or ACP lane is enabled on dogfood. The Codex sign-in path
   additionally needs the `ChatGptAuth` binding.
3. No live recorded call exists for any provider or channel.
4. Linear has minimal tests.
5. The acceptance journeys were not re-run for this report. Their latest
   evidence is from 2026-10-31 at an older revision.

Recording a live run on dogfood needs, at minimum, `AI_GATEWAY_TOKEN` and a
google BYOK key for the OpenCode path, with the per-channel secrets above.
