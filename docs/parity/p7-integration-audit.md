# P7 — Integration audit: automations, GitHub, provider OAuth, integrations

Date: 2026-10-16. Read-only audit of `main` (deeb37f + uncommitted v1 work). This audit changed no source files.

User report: "automation, github connection, provider OAuth connection, integrations are not working end to end."

## TL;DR

The main cause is in the deployment, not the code. The live Worker
(`shiba-ai-coworker`, version `89324dd4-5e7c-473f-941f-cd10466e13ce`,
deployed 2026-10-15 by `wrangler deploy` upload) has **2 secrets**:
`BETTER_AUTH_SECRET` and `TYPESAFE_API_KEY`. Every integration secret is
missing: `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_*`, `AI_GATEWAY_TOKEN`,
`CLAUDE_SUBSCRIPTION_TOKEN`, `GMAIL_*`, `DISCORD_*`, `TELEGRAM_*`, and
`DASHBOARD_APPROVERS`. The only subscription flag set is `SHIBA_CLAUDE_SUBSCRIPTION`.
Each route therefore fails closed with a 503, 400 or 404. The code also has three
real breaks: automation and chat runs never show in the dashboard, Antigravity
runs never get their token, and the GitHub "connect" / repo-list / branch-list
feature does not exist.

Evidence for the live state (read-only):

```
$ npx wrangler secret list --config apps/backend/wrangler.jsonc
BETTER_AUTH_SECRET
TYPESAFE_API_KEY
$ npx wrangler versions view 89324dd4-…   # vars on the live version
BETTER_AUTH_URL="https://app.tryshiba.dev"  CODING_MODEL  GATEWAY_ID  INSTANCE_TYPE
ORCHESTRATOR_MODEL  RUNTIME  SHIBA_CLAUDE_SUBSCRIPTION="1"  WORKER_HOSTNAME
Handlers: scheduled, email, fetch
```

`.env` holds `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_*`, `AI_GATEWAY_TOKEN`
and `DEVIN_API_KEY`. Only `alchemy deploy` (`pnpm deploy:alchemy`) binds them,
through `secrets([...])` at `alchemy.run.ts:258`. A `wrangler deploy` upload never
pushes `.env`, so the deploy path that was actually used shipped without them.

Tests: 28 related backend test files ran, **494/494 passed**. Command:
`npx vitest run` over automation-runner, automations, *-subscription, discord,
github*, gmail*, mcp-gateway, oauth-mcp, sentry-webhook, slack*, telegram and
better-auth. The tests stub the DO and orchestrator seams and the env, so none of
them can catch the breaks listed here.

## Ranked findings

| # | Sev | Flow | Break | Where |
|---|-----|------|-------|-------|
| 1 | P0 | All | Live Worker is missing all integration secrets | deployment (see above) |
| 2 | P0 | Automations | Every queue returns 400 because `GITHUB_TOKEN` is unset and automations always set `publishPullRequest:true` | `agents/orchestrator.ts:1419`, `automation-runner.ts:214,227`, `automations-do.ts:55` |
| 3 | P0 | Automations, review lane, Sentry | The dashboard can never approve shared approvals: `DASHBOARD_APPROVERS` is not provisioned anywhere | `approvals-routes.ts:111-116` |
| 4 | P1 | Automations, GitHub review, Slack/Discord/Telegram | Runs are queued on DO `default` (or a chat DO), but `GET /api/runs` reads only the DO named by the user's email, so the results never show | `runs-routes.ts:31,49` vs `automations-do.ts:151`, `slack-routes.ts:21` |
| 5 | P1 | GitHub | No GitHub App install, OAuth callback, repo list or branch list exists. "Connect ↗" opens the PAT page and there is nowhere to store the token | `IntegrationsView.tsx:150-155`; only `/api/github/webhook` exists (`github-webhook-routes.ts:17`) |
| 6 | P1 | Providers | Codex, Cursor, Devin and Antigravity flags are missing from `wrangler.jsonc` vars, so their routes return 404 and the cards say "not enabled on this deployment" | `wrangler.jsonc:27-84`, `auth-routes.ts:205,211,217,225` |
| 7 | P1 | Providers (Antigravity) | The OAuth token is written into auth sandbox `agy-auth-<acct>`, but runs execute in sandbox `run-<hash>`, which has an empty profile | `packages/auth/src/antigravity-subscription.ts:65-69,174-176`; `security.ts:88-90`; `harness/antigravity-subscription.ts` `setupCommands` |
| 8 | P2 | OAuth MCP | A browser that is not signed in gets a JSON 401 from `/oauth/authorize`, with no sign-in redirect and no return URL | `index.ts:193-205`; `request-auth.ts:59-66` leaves `/oauth/authorize` out on purpose |
| 9 | P2 | Gmail | The Google redirect lands on a raw JSON page. The dashboard tab only polls | `gmail-routes.ts:70-76` |
| 10 | P2 | Automations | There is no update, disable or delete endpoint, and the UI has no control for it. The pr-review recipe duplicates the built-in review lane, so each PR gets 2 approvals | `automations-do.ts:299-366`, `automations-do.ts:189-230`, `AutomationsView.tsx:24-32` |
| 11 | P3 | Automations UI | Status text is hardcoded: "Signature Verified" shows even with no secret, "Active & Bound" is static, and "Hourly Health Tick" is wrong because the cron runs every 5 minutes | `AutomationsView.tsx:325,399,409` |
| 12 | P3 | Env drift | `env.ts` keys that are never provisioned by alchemy or `.env.schema`. Each alchemy deploy also strips any that were set by hand | see the drift table |

## 1. Automations — BROKEN (live), PARTIAL (code)

Trace: `AutomationsView` "Deploy recipe" → `POST /api/automations` (`AutomationsView.tsx:117`)
→ `handleAutomations` (`automations-routes.ts:11`) → `Automations` DO `POST /api/automations`
(`automations-do.ts:303`) → stored. **Works.**

Triggers:
- Schedule: cron `*/5 * * * *` (`wrangler.jsonc:96-98`) → `scheduled()` (`index.ts:111-123`) → DO `/internal/tick` (`automations-do.ts:156`) → `fireMatchingAutomations`. The live version has a `scheduled` handler.
- Manual: "Run now" → `POST /api/automations/:id/run` (`automations-do.ts:324-336`).
- Webhook: `POST /api/automations/:id/trigger` with an `x-automation-secret` header. It is public (`request-auth.ts:72`) and on the Access bypass list (`alchemy.run.ts:124`).
- GitHub and Slack: fan-out from the verified webhooks (`github-webhook-routes.ts:85-102`, `index.ts:317-333`).

All triggers then follow `fireAutomation` → `deps.queueRun` → orchestrator `POST /api/runs`
(`automations-do.ts:48-58`) → `queueSlackRun` (`orchestrator.ts:1327`).

**Break 2 (P0).** `fireAutomation` hardcodes `publishPullRequest: true` (`automation-runner.ts:214,227`).
`queueSlackRun` refuses that when `GITHUB_TOKEN` is unset:

```ts
// agents/orchestrator.ts:1419
if (publishPullRequest && !this.env.GITHUB_TOKEN) {
  return Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 });
```

`queueOnOrchestrator` then throws `Queue failed (400).` (`automations-do.ts:55`). The skip
is recorded as `lastSkip.reason = "Queue failed: Queue failed (400)."` (`automation-runner.ts:254-257`).
- Expected: an approval card appears.
- Actual: nothing is queued. The UI shows `Skipped "<id>" — see lastSkip` (`AutomationsView.tsx:155`).
- Smallest fix: `npx wrangler secret put GITHUB_TOKEN --config apps/backend/wrangler.jsonc`, using a token with repo and PR write access.

**Break 3 (P0).** When the user approves from the dashboard, `POST /api/approvals` gets a
threadKey of `automation:<id>`. The PR review lane uses `review:<repo>#<n>` and Sentry uses
`sentry:<id>`. None of these start with `WEB_SESSION_PREFIX`, so the request falls into:

```ts
// approvals-routes.ts:111
} else if (!isApprover(decidedBy, parseApproverAllowlist(env.DASHBOARD_APPROVERS))) {
  return Response.json({ error: "Not authorized to resolve shared approvals." }, { status: 403 });
```

`DASHBOARD_APPROVERS` is declared only at `env.ts:230`. It is missing from `wrangler.jsonc`,
from both lists in `alchemy.run.ts`, and from `.env.schema` / `.env`, and the live Worker
does not have it. Automation approvals are not posted to Slack either: only email
approvals post cards (`orchestrator.ts:1914`). So no surface can ever approve them.
- Expected: Approve starts the run.
- Actual: 403 toast, "Not authorized to resolve shared approvals."
- Smallest fix: `wrangler secret put DASHBOARD_APPROVERS` with the operator's sign-in email (`resolveUserId` returns the better-auth email, see `packages/auth/src/better-auth.ts:253`). Then add it to `alchemy.run.ts` `secrets([...])` and `.env.schema`, or the next alchemy deploy removes it.

**Break 4 (P1), "result visible".** The run executes on DO `default` (`automations-do.ts:151`,
`ORCHESTRATOR_NAME = "default"` at `slack-routes.ts:21`). The dashboard's run list
(`app.tsx:68-70`) calls `GET /api/runs`. That resolves to the DO named by
`resolveUserId`, which is the signed-in email (`runs-routes.ts:31,49`). It never reads
`default`. `GET /api/approvals`, by contrast, does fan out to `default`
(`approvals-routes.ts:60`). So the card shows up, but the run, its progress and its
PR link never do. `/api/v1/*` uses the same `resolveRunStoreTarget` (`v1-routes.ts:49,89`),
so it has the same gap.
- Smallest fix: in `handleRuns`, for an unscoped `GET /api/runs` with no id, also fetch the `ORCHESTRATOR_NAME` stub and concatenate its `runs`, the same way `approvals-routes.ts:60-83` merges approvals. Run detail (`/api/runs/:id`) needs the same fallback: try the user DO first, and on 404 try `default`.

**P2/P3.**
- There is no PATCH or DELETE for automations (`automations-do.ts:299-366`), so a deployed recipe cannot be paused or removed. The deploy button stays disabled (`AutomationsView.tsx:222`).
- The `pr-review` recipe (`github` `pull_request:opened`) duplicates the built-in review lane, which always queues on `opened` and `synchronize` (`automations-do.ts:189-230`). Each PR gets 2 approvals.
- Hardcoded status text: `AutomationsView.tsx:325` ("Signature Verified" regardless of `GITHUB_WEBHOOK_SECRET`), `:399` ("Active & Bound"), `:409` ("Hourly Health Tick"; the cron is `*/5`).
- `setup-status.ts:69-72` treats `AUTOMATIONS_ENABLED="no"` as enabled, while `automationsEnabled()` (`automations.ts:788-791`) treats it as disabled. Cosmetic.

## 2. GitHub connection — BROKEN (live) / NOT IMPLEMENTED (app/OAuth)

What exists:
- `POST /api/github/webhook`: HMAC check, replay dedupe, then fan-out to the Automations DO (`github-webhook-routes.ts:15-109`).
- PR publish through `GITHUB_TOKEN` (`github.ts:79`).
- Git egress that scopes the token to one repo (`opencode-agent.ts:50-68`).

Breaks:
- **Live:** `GITHUB_WEBHOOK_SECRET` is unset, so every delivery gets `503 Webhooks are not configured` (`github-webhook-routes.ts:20-26`). GitHub marks the hook as failing. Because `GITHUB_TOKEN` is unset, PR publish is refused at queue time (`orchestrator.ts:1419`) and private repos cannot be cloned.
- **Break 5 (P1):** No GitHub App install flow, OAuth callback, `/api/github/repos` or `/api/github/branches` exists in the backend. A grep for `/api/github` finds only the webhook. In the frontend, the "Connect ↗" action (`IntegrationsView.tsx:150-155`) opens `github.com/settings/tokens/new`, and the UI has no field or endpoint to save the token. The repo picker uses `localStorage` saved repos plus run history (`app.tsx:1218`). Base branch is free text (`app.tsx:339`).
  - Expected: install or authorize → repos and branches listed.
  - Actual: the user has to create a PAT and run `wrangler secret put` by hand.
  - Smallest fix: (a) document "Connect" as operator setup and set the 2 secrets now; (b) add `GET /api/github/repos` (`GET https://api.github.com/user/repos?per_page=100`) and `GET /api/github/branches?repo=o/r` (`GET /repos/{o}/{r}/branches`), both authenticated with `GITHUB_TOKEN`, and feed them to the composer. An App or OAuth install is a feature, not a fix.
- The UI copies the webhook URL as a relative path, `/api/github/webhook` (`AutomationsView.tsx:338`). GitHub needs the absolute URL `https://app.tryshiba.dev/api/github/webhook`.
- `GITHUB_PROJECT_TOKEN` and `GITHUB_PROJECT_NUMBER` (`env.ts:238-240`) are not provisioned anywhere, so project-board sync is silently off.
- The review lane is pinned to `opencode-go/gpt-6.1-sol` (`automations-do.ts:217`) and needs a working opencode-go gateway connection. Not verified live.

## 3. Provider OAuth / subscriptions — PARTIAL

Path: `SubscriptionConnect` (`SubscriptionConnect.tsx:220-317`) → `/api/auth/<provider>-subscription[/begin|verify|clear]`.
The better-auth lane does not take these paths (`packages/auth/src/better-auth.ts:39-46`),
so `handleSubscriptionAuth` serves them (`auth-routes.ts:196`). Flow state lives in KV
`AGENT_TOKENS` (`packages/auth/src/controller.ts:109,125`). The run admission gate reads
the same controller (`auth/index.ts:62-75`). Route and harness instance ids match:
`claude-sub:<acct>` (`harness/claude-subscription.ts:68`), `agy-sub:<acct>`, and
`codex-sub:<home>` (`auth-routes.ts:87`, `harness/codex-subscription.ts:97`).

- **Claude — BROKEN (live).** The flag is on, but `CLAUDE_SUBSCRIPTION_TOKEN` is unset. `begin` throws `CLAUDE_SUBSCRIPTION_TOKEN is not set…` (`packages/auth/src/claude-subscription.ts:91-95`), which shows as a red 400 in the card. This is not an OAuth flow by design: the button only probes an operator secret through egress (`egress.ts:128-173`). Fix: run `claude setup-token`, then `wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN`. `.env` does not have it either, so alchemy deploys would not bind it.
- **Codex / Cursor / Devin / Antigravity — DARK (Break 6).** `wrangler.jsonc` vars set only `SHIBA_CLAUDE_SUBSCRIPTION` (`wrangler.jsonc:32`), so `auth-routes.ts:205/211/217/225` return 404 and the card shows "sign-in is not enabled on this deployment" (`SubscriptionConnect.tsx:364-373`). There is no `keep_vars`, so each `wrangler deploy` wipes any flag added in the dashboard. Fix: add `"SHIBA_CODEX_SUBSCRIPTION": "1"` (and the others) to `wrangler.jsonc` `vars`, plus the matching credential secrets (`CODEX_SUBSCRIPTION_AUTH_JSON`, `CURSOR_SUBSCRIPTION_TOKEN`, `DEVIN_SUBSCRIPTION_TOKEN`).
- **Antigravity — BROKEN by design even when enabled (Break 7).** Sign-in runs `agy` in sandbox `agy-auth-<acct>` (`packages/auth/src/antigravity-subscription.ts:65-69`), and the token file `acp_token.json` (`packages/shared/src/antigravity.ts:233`) is written to that container's disk. `verify` probes that same sandbox (`:174-176`), so admission passes. The run, however, executes in `run-<cyrb53>` (`security.ts:88-90`, `orchestrator.ts:901,2142`). There, the harness only `mkdir`s an empty profile (`harness/antigravity-subscription.ts` `setupCommands`/`configFile`), and no code path copies the token. Container disk is also ephemeral, so the auth sandbox loses the token once it sleeps.
  - Expected: a signed-in account runs tasks.
  - Actual: the run starts with no token and the ACP agent fails auth. In-run refresh is blocked by egress (`ANTIGRAVITY_SUBSCRIPTION_HOSTS`).
  - Fix (not small): before `buildArgv`, read the token with `exec cat` from the auth sandbox and `writeFile` it into the run sandbox profile (mode 0600). Or persist the token in KV, encrypted like Gmail's `refreshCipher`, and write it in at setup.
- **OAuth MCP (`oauth-mcp.ts`) — PARTIAL (Break 8).** Discovery, `/oauth/register`, `/oauth/token` and `/oauth/revoke` are anonymous (`request-auth.ts:59-66`). `/oauth/authorize` is behind the dashboard gate on purpose, because the owner must approve. A browser with no session cookie gets `{"error":"Authentication required.","code":"better_auth"}` (`index.ts:193-205`) and cannot reach a sign-in page that returns to the consent screen. It works only when the browser is already signed in to app.tryshiba.dev. Fix: in the `index.ts` gate, send a `302` to `/?next=<encoded authorize URL>` for unauthenticated `GET /oauth/authorize`, and have the frontend sign-in follow `next` (same-origin only). The issuer is the request origin (`oauth-mcp.ts:173-175`), so it is correct on the single host.

## 4. Integrations

- **Slack — BROKEN (live).** `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are unset, so `/api/slack/events` and `/api/slack/command` return `503 Slack is not configured` (`slack-events.ts:110-113`, `slack-routes.ts:176-179`). The code is complete (approval cards, interact, mention, automation fan-out at `index.ts:311-338`). The values are in `.env`. Push them with `wrangler secret put` (or `wrangler secret bulk`).
- **Discord — BROKEN (live).** `DISCORD_PUBLIC_KEY` is unset, so `503` (`discord.ts:127-129`). `DISCORD_BOT_TOKEN` (`chat-lane.ts:258`) is missing from alchemy `secrets([...])`, so progress posts are off even after an alchemy deploy.
- **Telegram — BROKEN (live).** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are unset, so `503` (`telegram.ts:200-204`).
- Chat-lane runs (Slack/Discord/Telegram) use non-user DOs (`discord:<channel>` at `discord.ts:161`, and others), so they hit Break 4: they are invisible in the dashboard run list.
- **Gmail — BROKEN (live) / PARTIAL.** `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` and `GMAIL_TOKEN_KEY` (64 hex) are all unset, so `503 Gmail is not configured` (`gmail.ts:65-68`). `GMAIL_CLIENT_ID` and `GMAIL_REDIRECT_URI` are alchemy `configVars` only (`alchemy.run.ts:352-353`) and are missing from `wrangler.jsonc` vars, so `wrangler deploy` drops them. The redirect must be exactly `https://app.tryshiba.dev/api/connections/gmail/callback` (`gmail.ts:73-77`) and must be registered in Google Cloud. After consent, the callback tab shows raw JSON (`gmail-routes.ts:76`). Smallest fix there: return `Response.redirect("/integrations?gmail=connected", 302)`. Agent grants need a token minted by the CLI (`GmailConnection.tsx:357`).
- **MCP gateway (`/mcp`) — WORKS.** The bindings `AGENT_TOKENS`, `MCP_RATE_LIMIT` and `AGENT_AUDIT` are live. The bearer check is at `mcp-routes.ts:54`, and the 401 carries `resource_metadata` (`mcp-routes.ts:61`). Tokens come only from the CLI (`scripts/mint-token.mjs`, see `AgentsView.tsx:77`) or from OAuth DCR (Break 8).
- **Sentry — DARK.** `SENTRY_WEBHOOK_SECRET` and `SENTRY_REPO_URL` (`env.ts:115-117`) are not in alchemy or `.env.schema`.
- **AI Gateway.** `AI_GATEWAY_TOKEN` is unset, so `cf-aig-authorization` is never sent (`egress.ts:78`). If the gateway has "Authenticated Gateway" turned on, every model call returns 401. Check `GET /api/setup/status` → `gateway.reachable`.

## Env / binding drift

Declared in `env.ts` but provisioned by neither `alchemy.run.ts` nor `.env.schema`. An
alchemy deploy removes any of these that were set by hand:

`DASHBOARD_APPROVERS`, `DISCORD_BOT_TOKEN`, `GITHUB_PROJECT_TOKEN`, `GITHUB_PROJECT_NUMBER`,
`SENTRY_WEBHOOK_SECRET`, `SENTRY_REPO_URL`, `TRIGGER_TOKEN`, `REVIEW_RUN_MODEL`,
`SLACK_AGENT_HARNESS`, `PLAN_MODEL`, `REVIEW_MODEL`, `UI_MODEL`, and `USAGE_BUDGET_USD`.
`INTERNAL_SIGNING_KEY` is also missing from alchemy, and `PAIRING_SECRET` is missing from the schema.
Binding: `LOADER` (`worker_loaders`, `wrangler.jsonc:88-90`) has no counterpart in
`alchemy.run.ts`, so codemode loses its loader after an alchemy deploy.

Missing from `wrangler.jsonc` vars, which `wrangler deploy` resets on every deploy:
`SHIBA_CODEX_SUBSCRIPTION`, `SHIBA_ANTIGRAVITY_SUBSCRIPTION`, `SHIBA_CURSOR_SUBSCRIPTION`,
`SHIBA_DEVIN_SUBSCRIPTION`, `GMAIL_CLIENT_ID`, `GMAIL_REDIRECT_URI`, `AUTOMATIONS_ENABLED`,
and `SLACK_APPROVALS_CHANNEL`. These are defaults; leaving them out is fine as long as it is intended.

`BETTER_AUTH_URL` is correct on the live version (`https://app.tryshiba.dev`). Alchemy
preview stages also hardcode it (`alchemy.run.ts:186`), but `trustedOrigins` adds the
request origin (`packages/auth/src/better-auth.ts:162`), so preview sign-in still works.
No better-auth callback URL break was found.

## Fix order (smallest first)

1. Push the secrets to the live Worker (`--config apps/backend/wrangler.jsonc`): `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APPROVERS`, `SLACK_CHANNEL_REPOS`, `AI_GATEWAY_TOKEN`, `DASHBOARD_APPROVERS=<operator email>`, `CLAUDE_SUBSCRIPTION_TOKEN`, and optionally the Gmail, Discord and Telegram sets. Or switch to `pnpm deploy:alchemy` after adding `DASHBOARD_APPROVERS` to `.env` and `alchemy.run.ts`. This alone fixes findings 1, 2 and 3, plus the live-side breaks in sections 2-4.
2. Add `DASHBOARD_APPROVERS` (and the other drift keys) to `alchemy.run.ts` `secrets([...])` and `.env.schema`.
3. Merge `default` DO runs into `GET /api/runs` and `/api/runs/:id` (Break 4).
4. Add the `SHIBA_*_SUBSCRIPTION` flags to `wrangler.jsonc` vars for any provider that should be connectable.
5. Gmail callback redirect; `/oauth/authorize` sign-in redirect; automation PATCH and DELETE; drop or disable the duplicate pr-review recipe; replace the hardcoded status text.
6. Antigravity token handoff into the run sandbox (design work).
7. GitHub repos and branches endpoints (feature).

## Verification after fixes

- `curl -sS -XPOST https://app.tryshiba.dev/api/github/webhook` → 401 "Invalid webhook signature" instead of 503. GitHub's "Recent Deliveries" shows 200.
- Automations → deploy "Manual Deep Audit" → Run now → notice `Fired … approval queued`. Approve on the Approvals view → 200 (not 403) → the run appears in the Tasks list once Break 4 is fixed.
- Agents & MCP → Claude card → Connect → chip shows "Connected". Queue a run with harness `claude-subscription` and confirm it passes admission (`auth/index.ts:70`).
- `GET /api/setup/status` → `github.token/webhookSecret`, `slack.*` and `gateway.token` are all true.
