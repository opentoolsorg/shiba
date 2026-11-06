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
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm check:deploy
export ALCHEMY_STAGE=dogfood          # never pass --stage
export CLOUDFLARE_ACCOUNT_ID=<account>
export WORKERS_SUBDOMAIN=<account workers.dev subdomain>
pnpm env:load                         # validates .env
pnpm deploy:preview                   # alchemy plan: read it before applying
pnpm deploy:alchemy                   # pnpm build && alchemy deploy
```

Read the plan first and confirm it creates `shiba-artifacts-dogfood` and the missing Durable Object classes, and that it does not touch `shiba-ai-coworker` (live).

## Migration order

Cloudflare applies migrations in list order, from the first tag the script has not yet recorded. Alchemy emits the tags for the classes it adds; wrangler lists them all.

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

**Skipping is safe** because every tag is additive (`new_sqlite_classes`) apart from the v4→v8 create-then-delete of `McpGateway`, which replays cleanly in order. A Worker that never saw v9–v15 gets them in sequence and ends with all classes. Risks to check in the plan:

- `alchemy:*` tags are only placeholders. If the dogfood script's recorded tag is not in this list, Cloudflare rejects the deploy (old tag mismatch). Check with `npx wrangler migrations list --name shiba-ai-coworker-dogfood` and compare against the table.
- Never edit, reorder or remove a tag to make a plan pass.
- Do not combine this deploy with a Sandbox SDK major bump (`docs/DEPLOY.md`).

## Secrets

Alchemy **replaces** the Worker's secret set with the names present in `.env` that are listed in `worker-secrets.json`. Anything set only with `wrangler secret put` is removed on the next Alchemy deploy, so put every one of these in `.env` before deploying. Do not paste values anywhere else.

| Secret | What it unlocks |
| --- | --- |
| `INTERNAL_SIGNING_KEY` | Edge-identity signing between the Worker and its Durable Objects, and signed Slack canvas/buffer requests. Must be at least 32 characters. Unset, the orchestrator falls back to trusting vouched headers and logs a warning. Also required by the shared-computer signing check. |
| `AI_GATEWAY_TOKEN` | Cloudflare AI Gateway auth for Gemini, Grok and OpenCode lanes. Not needed for the ChatGPT or Claude subscription lanes or a paired local daemon running Claude Code (`AGENTS.md`). |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack requests; without it the Slack ingress is dark. |
| `SLACK_BOT_TOKEN` | Lets the Worker post and read in Slack. |
| `SLACK_INSTALLATION_KEYRING` | JSON keyring (max 1024 chars) that encrypts stored Slack installations. Needed once `SLACK_INSTALLATIONS_ENABLED` is turned on; the flag is `false` by default. |

Also needed for a usable dogfood stage: a built-in auth pair (`BETTER_AUTH_SECRET` of at least 32 characters plus `BETTER_AUTH_BOOTSTRAP_TOKEN` or `BETTER_AUTH_OWNER_EMAIL`) or `ACCESS_EMAILS`, and `ARTIFACT_SIGNING_KEY` (at least 32 bytes) for signed artifact downloads. Run the local runtime only with `SHIBA_LOCAL_RUNTIME=1` and `LOCAL_ADAPTER_TOKEN` or `PAIRING_SECRET`.

## Rollback

- Code and bindings: redeploy the previous commit with the same command (`git checkout <previous-sha>`, then repeat the deploy). Durable Object migrations do not roll back, and classes added by v9–v15 stay on the script. That is harmless because older code simply does not use them.
- Do not delete DO classes to undo a deploy; that needs a new `deleted_classes` tag and destroys state.
- Secrets: Alchemy replaces the set, so rollback must run with the previous `.env`.
- Emergency script-only path: `npx wrangler deploy --name shiba-ai-coworker-dogfood --config apps/backend/wrangler.jsonc` needs the name override and keeps undeclared secrets, but does not manage the stage-suffixed resources. Prefer Alchemy.
- `pnpm deploy:destroy` with `ALCHEMY_STAGE=dogfood` removes the whole stage. It is not a rollback.

## Post-deploy smoke checks

Use the printed `workers.dev` origin for `dogfood`.

1. `GET /api/setup/status` returns JSON (not SPA HTML) and, after sign-in, no missing-binding errors.
2. `GET /app/` loads and sign-in works (Access or built-in auth).
3. In the dashboard Providers and Setup doctor view, confirm `INTERNAL_SIGNING_KEY` and `AI_GATEWAY_TOKEN` read as configured.
4. Open a session in two tabs: the `ConversationRoom` presence indicator appears (see `docs/ROOM-REALTIME.md`).
5. Connect the ChatGPT plan: exercises `ChatGptAuth`. Connect a provider via OAuth: exercises `UserProviderOAuth`.
6. Download a run artifact: exercises `ARTIFACTS` and `ARTIFACT_SIGNING_KEY`.
7. Local runtime (if enabled): `POST /api/local/claim` with a wrong bearer returns 401, and `node scripts/shiba-local-daemon.mjs --once` reports "no pending runs".
8. Slack (if enabled): a test message reaches the Worker with a valid signature and a forged one returns 401.
9. Queue a throwaway task with publishing disabled and confirm no sandbox starts before approval.
10. Confirm the live Worker `shiba-ai-coworker` is unchanged (version list in the dashboard).
