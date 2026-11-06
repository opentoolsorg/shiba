# Dogfood Worker deploy checklist (2026-11-06)

**Why this exists.** The `shiba-ai-coworker-dogfood` Worker (latest version uploaded 2026-11-06 05:34 UTC) predates several bindings in current source. This checklist is for the owner to bring it current. Automation must not run any command below (see `docs/DEPLOY.md`).

## Source audit (done, no drift found)

- `pnpm check:deploy` passes: `alchemy.run.ts` and `apps/backend/wrangler.jsonc` agree (67 declared bindings/vars), `env.ts` matches, and `deploy-config.test.mjs` passes 7/7.
- Durable Object migration tags are append-only in git history: `v1…v9, alchemy:v10, alchemy:v11, v12, alchemy:v22, v13, v14, v15`. No tag was edited or removed.
- `ConversationRoom` (v15), `ChatGptAuth` (v12), `UserProviderOAuth` (v13) and `LocalDispatch` (v9) are bound in both deploy files. `ARTIFACTS` is an R2 bucket (`shiba-artifacts${suffix}`) in both.
- **`ComputerSession` is intentionally not bound.** It is exported from `src/index.ts` and typed as optional in `env.ts`, but has no `durable_objects` binding or migration tag in either deploy file. Per `ARCHITECTURE.md` the default stack does not provision it, and it needs a reviewed container image (`SHIBA_SHARED_COMPUTER_IMAGE`). A deploy from this source will **not** add it. Adding it needs a new `v16` tag in both files plus the image; it is not part of this checklist.
- The five secrets are listed in `worker-secrets.json` and in alchemy's `secrets([...])`; they are absent from the Worker only because nobody has set them.

## Which deploy path

`shiba-ai-coworker-dogfood` is the Alchemy stage `dogfood` (`alchemy.run.ts` names the Worker `shiba-ai-coworker-${ALCHEMY_STAGE}` for any non-`live` stage). `wrangler.jsonc` hardcodes the name `shiba-ai-coworker` (live), so **a plain wrangler deploy would hit live, not dogfood**. Use Alchemy.

## Deploy command

From the repo root on the owner's Mac (Docker running, or `SANDBOX_IMAGE` pointing at a pre-pushed `registry.cloudflare.com/<account>/...` image):

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built
pnpm check:ci
pnpm check:deploy
export ALCHEMY_STAGE=dogfood          # never pass --stage
export CLOUDFLARE_ACCOUNT_ID=<account>
export WORKERS_SUBDOMAIN=<account workers.dev subdomain>
# alchemy.run.ts calls process.loadEnvFile(".env"), so .env wins over the shell.
# Remove any live WORKER_HOSTNAME / BETTER_AUTH_URL from .env too, then either
# leave both unset or set the dogfood origin in each one's own form:
#   WORKER_HOSTNAME=shiba-ai-coworker-dogfood.<subdomain>.workers.dev   (no scheme)
#   BETTER_AUTH_URL=https://shiba-ai-coworker-dogfood.<subdomain>.workers.dev
# The preflight rejects any other value on a non-live stage.
pnpm env:load                         # validates .env
pnpm env:scan
pnpm deploy:preview                   # alchemy plan: read it before applying
pnpm deploy:alchemy                   # pnpm build && alchemy deploy
```

Read the plan first and confirm it creates `shiba-artifacts-dogfood` and the missing Durable Object classes, and that it does not touch `shiba-ai-coworker` (live).

Do not set `ACCESS_AUD` or `REQUIRE_ACCESS`; the preflight rejects both. A non-live stage with neither `ACCESS_EMAILS` nor a `BETTER_AUTH_SECRET` + bootstrap pair deploys with an **open dashboard** (`deploy-config.ts` `openDashboard`), so configure one of them for dogfood.

## Migration order

Cloudflare applies migrations in list order, from the first tag the script has not yet recorded. The two deploy paths record tags differently:

- **Alchemy (the path used here)** emits its own provider tag for the classes it adds, of the form `alchemy:vN`. It does not consume the `v*` entries below; those exist so a later wrangler deploy can replay the same history.
- **Wrangler** walks the `v*` list below in order.

After an Alchemy deploy, read the tag the script now carries (see the check below) and append it to `wrangler.jsonc` `migrations` as a bare `{ "tag": "alchemy:vN" }` entry, exactly as `alchemy:v10`, `alchemy:v11` and `alchemy:v22` were recorded. Without that entry a later wrangler deploy sees an unknown tag and re-applies history.

| Tag | Change |
| --- | --- |
| v1 | `CodingOrchestrator`, `OpenCodeAgent`, `Sandbox` |
| v2 | `Automations` |
| v3 | `Mailbox` |
| v4 | `McpGateway` (created) |
| v5 | `Memory` |
| v6 | `Waitlist` |
| v7 | `ModelConfig` |
| v8 | `McpGateway` (deleted) |
| v9 | `LocalDispatch` |
| alchemy:v10, alchemy:v11 | placeholders left by earlier Alchemy deploys, no class changes |
| v12 | `ChatGptAuth` |
| alchemy:v22 | placeholder for the live script's tag after the Oct 20 deploy |
| v13 | `UserProviderOAuth` |
| v14 | `Spaces` |
| v15 | `ConversationRoom` |

**Skipping is safe on the wrangler path** because every tag is additive (`new_sqlite_classes`) apart from the v4→v8 create-then-delete of `McpGateway`, which replays cleanly in order. A Worker that never saw v9–v15 gets them in sequence and ends with all classes. Risks to check in the plan:

- `alchemy:*` tags are only placeholders. Wrangler 4.140 has **no** `migrations list` subcommand (the one in `docs/DEPLOY.md` is stale). Read the script's `migration_tag` from `GET /accounts/<account_id>/workers/services/shiba-ai-coworker-dogfood` (`default_environment.script.migration_tag`) or from the current version's details in the dashboard (Workers → `shiba-ai-coworker-dogfood` → Deployments), and compare it against the table before changing anything.
- If that tag is missing from the list, wrangler warns and re-applies **every** migration, which then fails on the first class that already exists. If it is present but not last, wrangler applies only the entries after it. Both behaviours are decided by the tag, so get it right before deploying.
- Before any wrangler fallback, reconcile the list against the classes the script already has: a tag that would re-create an existing class fails, and a missing tag re-applies history.
- Never edit, reorder or remove a tag to make a plan pass.
- Do not combine this deploy with a Sandbox SDK major bump (`docs/DEPLOY.md`).

## Secrets

Alchemy **replaces** the Worker's secret set with the names present in `.env` that are listed in `worker-secrets.json`. Anything set only with `wrangler secret put` is removed on the next Alchemy deploy.

Before deploying, inventory what dogfood already has and make sure every name you intend to keep is in `.env`:

```sh
npx wrangler secret list --name shiba-ai-coworker-dogfood
```

Compare that list with `apps/backend/worker-secrets.json` and with the five names below. Any active secret missing from `.env` is deleted by the deploy. Do not paste values anywhere else.

**Stop if dogfood has an active secret that is not in `worker-secrets.json`.** Per-account subscription secrets such as `CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>` are resolved at egress by name and are deliberately absent from the manifest, so Alchemy neither binds nor preserves them and a `.env` entry does not save them. There is no supported preservation path today: decide explicitly whether to drop the lane or keep the Worker on wrangler-only secrets before running `deploy:alchemy`.

| Secret | What it unlocks |
| --- | --- |
| `INTERNAL_SIGNING_KEY` | Edge-identity signing between the Worker and its Durable Objects, and signed Slack canvas/buffer requests. Must be at least 32 characters. Unset, the orchestrator falls back to trusting vouched headers and logs a warning. Also required by the shared-computer signing check. |
| `AI_GATEWAY_TOKEN` | Cloudflare AI Gateway auth for Gemini, Grok and OpenCode lanes. Not needed for the ChatGPT or Claude subscription lanes or a paired local daemon running Claude Code (`AGENTS.md`). |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack requests; without it the Slack ingress is dark. |
| `SLACK_BOT_TOKEN` | Lets the Worker post and read in Slack. |
| `SLACK_INSTALLATION_KEYRING` | JSON keyring (max 1024 chars) that encrypts stored Slack installations. Needed once `SLACK_INSTALLATIONS_ENABLED` is turned on; the flag is `false` by default. |

Also needed for a usable dogfood stage: a built-in auth pair (`BETTER_AUTH_SECRET` of at least 32 characters plus `BETTER_AUTH_BOOTSTRAP_TOKEN` or `BETTER_AUTH_OWNER_EMAIL`) or `ACCESS_EMAILS`, and `ARTIFACT_SIGNING_KEY` (at least 32 bytes) for signed artifact downloads. Run the local runtime only with `SHIBA_LOCAL_RUNTIME=1` and `LOCAL_ADAPTER_TOKEN` or `PAIRING_SECRET`.

## Rollback

- Code and bindings: redeploy the previous commit with the same command (`git checkout <previous-sha>`, then repeat the deploy). Durable Object migrations do not roll back, and classes added by v9–v15 stay on the script. **Keep the current `wrangler.jsonc` `migrations` list and the current DO exports when reverting application code** — an older config whose last tag predates the script's tag is rejected, and dropping a class export while its binding remains breaks the Worker. Revert code, not migration history.
- Inspect the plan for `deleted_classes` before redeploying, but do not rely on it: Alchemy manages migrations itself and may not surface a class deletion in the plan. Compare the deployed class inventory (the Worker's Durable Object bindings and the script's `migration_tag`) with the rollback commit's declarations before deploying. A revert that removes a class declaration can emit a deletion migration that destroys its state.
- Do not delete DO classes to undo a deploy; that needs a new `deleted_classes` tag and destroys state.
- Secrets: Alchemy replaces the set, so rollback must run with the previous `.env`.
- **Do not use `wrangler deploy` with `apps/backend/wrangler.jsonc` for dogfood.** That file carries `routes: [{ pattern: "app.tryshiba.dev", custom_domain: true }]`, so even with `--name shiba-ai-coworker-dogfood` it would attach the live custom domain to the dogfood script and steal production traffic. The wrangler path in `docs/DEPLOY.md` is for the live Worker only. A script-only dogfood fallback would need its own reviewed config: no `routes`, stage-suffixed R2 buckets, KV namespace, D1 database and container, and the same `migrations` list. Do not improvise one during an incident.
- `pnpm deploy:destroy` with `ALCHEMY_STAGE=dogfood` removes the whole stage. It is not a rollback.

## Post-deploy smoke checks

Use the printed `workers.dev` origin for `dogfood`.

1. `GET /api/setup/status` returns JSON (not SPA HTML) and, after sign-in, no missing-binding errors.
2. `GET /app/` loads and sign-in works (Access or built-in auth).
3. In the dashboard Providers and Setup doctor view, confirm `INTERNAL_SIGNING_KEY` and `AI_GATEWAY_TOKEN` read as configured.
4. Open a session in two tabs: the `ConversationRoom` presence indicator appears (see `docs/ROOM-REALTIME.md`).
5. Connect the ChatGPT plan: exercises `ChatGptAuth`. Connect a provider via OAuth: exercises `UserProviderOAuth`.
6. Download a run artifact: exercises `ARTIFACTS` and `ARTIFACT_SIGNING_KEY`.
7. Local runtime (if enabled): `POST /api/local/claim` with a wrong bearer returns 401. Only then, with an explicit target and a throwaway run root, `SHIBA_WORKER_URL=https://shiba-ai-coworker-dogfood.<subdomain>.workers.dev LOCAL_ADAPTER_TOKEN=<dogfood token> SHIBA_LOCAL_RUN_ROOT=$(mktemp -d) node scripts/shiba-local-daemon.mjs --once`. `--once` can claim and execute a real pending run, so run it only when the queue is known empty; never point it at a saved config that may target live.
8. Slack (if enabled): a test message reaches the Worker with a valid signature and a forged one returns 401.
9. Queue a throwaway task with publishing disabled and confirm no sandbox starts before approval.
10. Confirm the live Worker `shiba-ai-coworker` is unchanged (version list in the dashboard).
