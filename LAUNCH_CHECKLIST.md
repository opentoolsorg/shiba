# Launch-Day Deploy Checklist — shiba-ai-coworker → app.tryshiba.dev

Read-only audit artifact. No deploy was run to produce this. Deploy is
`alchemy.run.ts` (primary); `apps/backend/wrangler.jsonc` is the rollback path.
Secrets are NEVER in either file — they ride via `wrangler secret put` /
alchemy `secrets()` env bindings.

Legend: **[REQ]** launch-blocking · **[LANE]** required only if that lane is used.

---

## 1. Provision backing resources (once, before first deploy)

wrangler.jsonc binds by fixed id/name — these must already exist:

```sh
cd apps/backend
npx wrangler kv namespace create AGENT_TOKENS        # id must equal 59cf73c3a6e0447fad8ced723d03fd13 in wrangler.jsonc
npx wrangler d1 create shiba-audit                 # database_id must equal a426d79d-295d-4875-ae93-90b8679aa466
npx wrangler r2 bucket create shiba-attachments
npx wrangler vectorize create shiba-memory --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index shiba-memory --property-name=agent --type=string
```

- [ ] KV `AGENT_TOKENS` exists with the pinned id (or update wrangler.jsonc).
- [ ] D1 `shiba-audit` exists with the pinned id.
- [ ] R2 `shiba-attachments` exists.
- [ ] Vectorize `shiba-memory` (768-dim cosine) + `agent` string metadata index.
- [ ] Email Routing → Email Sending enabled on the account (SEND_EMAIL binding).
- [ ] AI Gateway named `default` exists (GATEWAY_ID=default) with BYOK keys
      for google-ai-studio / anthropic / openai / grok / opencode-go as needed.
- [ ] Sandbox image: either local Docker for `containers.image = ./Dockerfile`
      build, or `SANDBOX_IMAGE=<registry.cloudflare.com ref>` exported
      (built by `.github/workflows/build-sandbox-image.yml`).

## 2. Set secrets — `npx wrangler secret put <NAME>` (from `apps/backend/`)

Core:

- [ ] **[REQ]** `AI_GATEWAY_TOKEN` — sent as `cf-aig-authorization` on every
      gateway forward (`src/egress.ts:78`). Required when the gateway is
      auth-gated or has no BYOK key stored. Reported by `/api/setup/status`
      as `gateway.token`.
- [ ] **[REQ]** `GITHUB_TOKEN` — required to open PRs; runs still work but
      publish fails without it.
- [ ] **[REQ]** `INTERNAL_SIGNING_KEY` — HMAC for Worker→DO request signing
      (`src/edge-identity.ts`). Unset = pre-signing header-trust behavior.
      ⚠ NOT in alchemy `secrets()` — see §7 mismatch list.
- [ ] **[REQ, pick one auth lane]** Cloudflare Access on the hostname
      (§4) **or** `BETTER_AUTH_SECRET` (≥32 chars) for built-in auth.
      Live alchemy deploys set `REQUIRE_ACCESS=1` — with neither lane,
      every dashboard/API request 401s (fail-closed by design).

Slack lane **[LANE]**:

- [ ] `SLACK_SIGNING_SECRET` — unset disables all Slack routes.
- [ ] `SLACK_BOT_TOKEN` — posts approval cards.
- [ ] `SLACK_APPROVERS` — comma-separated Slack user ids; empty = nobody can approve.
- [ ] `SLACK_CHANNEL_REPOS` — JSON `{channelId: "https://github.com/owner/repo"}`.
- [ ] `SLACK_APPROVALS_CHANNEL` (var, not secret) — channel for email-kind cards.
- [ ] `DASHBOARD_APPROVERS` — comma-separated dashboard sign-in emails allowed to
      approve shared runs (automations, PR review lane, Sentry, email); empty =
      nobody, so those cards 403 from the dashboard.

GitHub webhook **[LANE]**:

- [ ] `GITHUB_WEBHOOK_SECRET` — verifies `/api/github/webhook` signatures.
- [ ] `GITHUB_PROJECT_TOKEN` + `GITHUB_PROJECT_NUMBER` — Projects v2 sync.
      ⚠ Neither is in alchemy `secrets()`/`configVars()` — see §7.

Other lanes **[LANE]**:

- [ ] `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` (vars: `TELEGRAM_APPROVERS`, `TELEGRAM_CHAT_REPOS`, `TELEGRAM_AGENT_HARNESS`).
- [ ] `DISCORD_PUBLIC_KEY` (vars: `DISCORD_APPROVERS`, `DISCORD_CHANNEL_REPOS`, `DISCORD_AGENT_HARNESS`).
      ⚠ `DISCORD_BOT_TOKEN` is read by the worker but NOT in alchemy `secrets()`.
- [ ] `TRIGGER_TOKEN` — bearer for `POST /api/trigger` (Apple Shortcuts etc.).
      Unset = route returns 503. ⚠ NOT in alchemy `secrets()`.
- [ ] `DEVIN_API_KEY` — devin harness (api.devin.ai + server.codeium.com egress).
- [ ] `TYPESAFE_API_KEY` — optional run_when provider.
- [ ] `LOCAL_ADAPTER_TOKEN` — T51 `shiba local` daemon bearer on `/api/local/*`.
- [ ] `PAIRING_SECRET` — optional T52 pairing-token HMAC (falls back to LOCAL_ADAPTER_TOKEN).
- [ ] Subscription lanes (each needs flag var + secret):
      `SHIBA_CLAUDE_SUBSCRIPTION=1` + `CLAUDE_SUBSCRIPTION_TOKEN`;
      `SHIBA_CODEX_SUBSCRIPTION=1` + `CODEX_SUBSCRIPTION_AUTH_JSON`;
      `SHIBA_CURSOR_SUBSCRIPTION=1` + `CURSOR_SUBSCRIPTION_TOKEN`;
      `SHIBA_DEVIN_SUBSCRIPTION=1` + `DEVIN_SUBSCRIPTION_TOKEN`;
      `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1` (no secret — OAuth lives in container).
      ⚠ Named-account variants (`<NAME>_<ACCOUNT>`) are resolved by name at
      egress but alchemy `secrets()` only binds the exact listed base names —
      named accounts are wrangler-deploy only until alchemy declares them.

## 3. Vars to verify (wrangler.jsonc `vars` / alchemy `configVars()`)

Already pinned identical in both: `GATEWAY_ID=default`,
`ORCHESTRATOR_MODEL=@cf/zai-org/glm-4.7-flash`,
`CODING_MODEL=google/gemini-3.5-flash-lite`, `RUNTIME=sandbox`,
`INSTANCE_TYPE=standard-1` (must equal containers `instance_type`),
`WORKER_HOSTNAME=app.tryshiba.dev`.

- [ ] `REQUIRE_ACCESS=1` — alchemy sets it automatically on live stages;
      on the wrangler path set it manually or the Access gate is advisory-only.
- [ ] Optional per env: `AGENT_HARNESS`, `AUTOMATIONS_ENABLED`,
      `MEMORY_ENABLED`, `AGENT_MAILBOX`, `BETTER_AUTH_URL`,
      `ROLE_MODEL_MAP` / `ROLE_MODEL__*`, model overrides
      (`CLAUDE_CODE_MODEL`, `CODEX_MODEL`, `DEVIN_MODEL`, `GROK_MODEL`,
      `PI_MODEL`, `ACP_MODEL`).
      ⚠ `SLACK_AGENT_HARNESS`, `USAGE_BUDGET_USD` are
      read by the worker but absent from alchemy `configVars()`.

## 4. Cloudflare Access on app.tryshiba.dev

Worker gate (`src/request-auth.ts`) requires an Access identity header or
better-auth session on every non-public path when `REQUIRE_ACCESS`/`ACCESS_AUD`
is set. `isPublicRequest` only exempts GET static pages + `POST /api/waitlist`.

- [ ] Create a self-hosted Access application for `app.tryshiba.dev` (allow
      owner emails), session 24h. Grab the AUD tag → set `ACCESS_AUD` (var)
      for JWT verification (`src/access-jwt.ts`).
      ⚠ alchemy's `DashboardAccess`/`MachineBypass` apps target
      `shiba-ai-coworker.<subdomain>.workers.dev` — but live deploys disable
      workers.dev. The alchemy-managed apps do NOT cover app.tryshiba.dev;
      the real hostname needs an operator-managed Access app regardless.
- [ ] Bypass (service-token or "bypass everyone" policy) for every
      worker-authenticated machine path — these callers cannot do Access login.
      alchemy `ACCESS_BYPASS_PATHS` covers:
      `/api/slack/events`, `/api/slack/command`, `/api/slack/interact`,
      `/api/telegram/webhook`, `/api/discord/interactions`,
      `/api/github/webhook`, `/mcp`, `/mcp/*`, `/api/automations/*/trigger`,
      `/api/waitlist`, `/api/trigger`.
      ⚠ NOT covered — add to the operator-managed app's bypass list:
      `/.well-known/oauth-authorization-server`,
      `/.well-known/oauth-protected-resource`, `/oauth/register`,
      `/oauth/token`, `/oauth/revoke` (MCP OAuth bootstrap — a client cannot
      hold a bearer before these), `/api/auth/*` (better-auth sign-in),
      `/api/antigravity/callback`, `/api/local/*` (T51 daemon bearer).

## 5. Deploy (operator runs — not part of this audit)

```sh
# primary
pnpm deploy:alchemy          # pnpm build && alchemy deploy
# rollback
cd apps/backend && npx wrangler deploy
```

## 6. Post-deploy verify (read-only)

```sh
cd apps/backend
npx wrangler deployments list
npx wrangler secret list          # confirm every §2 secret shows "Secret Text"
npx wrangler containers list      # shiba-ai-coworker-sandbox, standard-1, max 5
```

Smoke tests against the live host:

```sh
# 1. Public landing — expect 200 (public static path)
curl -si https://app.tryshiba.dev/ | head -1

# 2. Gate closed — expect 401 {"error":"Authentication required."}
curl -si https://app.tryshiba.dev/api/whoami | head -1
curl -si https://app.tryshiba.dev/api/setup/status | head -1

# 3. Waitlist bypass — expect 400/422 validation error, NOT 401/302 (Access)
curl -si -X POST https://app.tryshiba.dev/api/waitlist \
  -H 'content-type: application/json' -d '{}' | head -1

# 4. Webhook bypass — expect 4xx from the signature check, NOT Access 302/403
curl -si -X POST https://app.tryshiba.dev/api/github/webhook \
  -H 'content-type: application/json' -d '{}' | head -1

# 5. MCP bypass — expect 401 from the worker token check
curl -si https://app.tryshiba.dev/mcp | head -1

# 6. Setup status (inside Access session or better-auth login) — expect JSON:
#    gateway.token:true, github.token:true, slack.*, access.required:true
curl -s https://app.tryshiba.dev/api/setup/status \
  -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" | jq

# 7. Cron — trigger fired */5; check logs
npx wrangler tail --status error
```

## 7. Known alchemy ↔ wrangler mismatches (audit findings — fix or accept)

1. `worker_loaders` **LOADER** — declared in wrangler.jsonc, ABSENT in
   alchemy.run.ts env. Code Mode `run_code` (`src/codemode.ts:76`) returns
   null → tool silently unavailable on alchemy deploys.
2. Worker-read secrets missing from alchemy `secrets()`: `TRIGGER_TOKEN`,
   `DISCORD_BOT_TOKEN`, `GITHUB_PROJECT_TOKEN`, `GITHUB_PROJECT_NUMBER`,
   `INTERNAL_SIGNING_KEY`. A `wrangler secret put` value may not survive an
   alchemy deploy (alchemy manages the declared binding set).
3. Named-account secrets (`CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>`,
   `CODEX_SUBSCRIPTION_AUTH_JSON_<ACCOUNT>`, `CURSOR_SUBSCRIPTION_TOKEN_<ACCOUNT>`,
   `DEVIN_SUBSCRIPTION_TOKEN_<ACCOUNT>`) — egress resolves them by name, but
   alchemy only binds exact listed names. Multi-account is wrangler-only.
4. Worker-read vars missing from alchemy `configVars()`: `SLACK_AGENT_HARNESS`,
   `USAGE_BUDGET_USD`.
5. `AGENT_MAILBOX` appears twice in alchemy `configVars()` (harmless duplicate).
6. Access apps: alchemy binds Access destinations to the workers.dev hostname
   that live stages disable — app.tryshiba.dev is never covered by the
   alchemy-managed apps; bypass list also omits OAuth discovery/registration,
   `/api/auth/*`, `/api/antigravity/callback`, `/api/local/*`.
7. wrangler.jsonc migrations v1–v9 are explicit; alchemy relies on
   provider-emitted migrations for new DO classes. Live adoption keeps
   existing history — verify `wrangler migrations list` after first alchemy deploy.
