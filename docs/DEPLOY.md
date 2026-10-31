# Deploy runbook (owner Mac only)

This repository intentionally has **two deploy entrypoints** that must declare the **same Worker surface**:

| File | Role |
| --- | --- |
| **`apps/backend/wrangler.jsonc`** | **Source of truth** — bindings, vars, Durable Object migrations, container image settings, routes, crons, and pinned resource IDs (KV, D1, R2, Vectorize). Wrangler is Cloudflare’s native config format and the **rollback** path; every static drift check compares against this file. |
| **`alchemy.run.ts`** | **Deploy orchestrator** — provisions or adopts the same stack via `pnpm deploy:alchemy`, manages optional Cloudflare Access apps, and binds deploy-time secrets from root `.env`. Must mirror `wrangler.jsonc`; never edit bindings here without updating wrangler first. |
| **`apps/backend/worker-secrets.json`** | **Secret binding manifest** — canonical list of Worker secret names. Alchemy `secrets([...])` must match exactly; wrangler operators use the same names with `wrangler secret put`. |

**CI gate:** `node scripts/check-alchemy-drift.mjs` (also `pnpm check:deploy`) fails on binding, var, container, or secret-list drift. `node scripts/check-env-types.mjs` keeps `apps/backend/src/env.ts` aligned with wrangler.

**Cloud agents and CI must not deploy.** No `wrangler deploy`, `wrangler secret put`, `d1 --remote`, `alchemy deploy`, or Pages deploy from automation — only the owner runs the commands below on a trusted Mac (Docker available for image builds).

---

## Prerequisites

- Node.js **22.13+**, **pnpm 10+**
- **Workers Paid** (Containers + Durable Objects)
- **Docker** (or OrbStack) for Sandbox image build unless `SANDBOX_IMAGE` points at a pre-pushed `registry.cloudflare.com/...` ref
- Cloudflare account with Workers, DO, Containers, Workers AI, KV, R2, D1, Vectorize enabled
- `npx wrangler login` **or** `CLOUDFLARE_API_TOKEN`; Alchemy additionally requires an explicit `CLOUDFLARE_ACCOUNT_ID` in the deploy environment
- Verify that account owns the intended custom domain, workers.dev subdomain, existing resource IDs and container image. Preflight checks account syntax and image-account agreement; it cannot prove remote ownership. Checked-in resource IDs and domain describe one installation and must be reviewed before using another account.

---

## Pre-deploy gate (every release)

From the repository root:

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built
pnpm check:ci
pnpm env:load && pnpm env:scan
pnpm check:deploy
```

Optional local packaging check (needs Docker, **no upload**):

```sh
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

---

## Staging Worker first (recommended)

Use an isolated Alchemy stage so live hostnames and stores are never touched.

1. Choose a stage name (lowercase, digits, hyphens): e.g. `staging-oct19`.
2. Export stage and deploy:

   ```sh
   export ALCHEMY_STAGE=staging-oct19
   pnpm env:load   # ensures .env is valid
   pnpm build
   pnpm deploy:alchemy
   ```

   Do **not** pass a conflicting `--stage` CLI flag; resource names are derived from `$ALCHEMY_STAGE` at module load (`alchemy.run.ts`).

3. Staging gets **suffixed** worker, container, and datastore names and **workers.dev** enabled with version preview URLs disabled. Set `WORKERS_SUBDOMAIN` to the target account's subdomain. `WORKER_HOSTNAME` and `BETTER_AUTH_URL` derive from that stage's workers.dev origin; remove inherited production overrides or set them to that exact host/origin. Staging never attaches the live custom domain.
4. Every public stage requires authentication: `ACCESS_EMAILS` creates managed Access at the stage's actual hostname, including staging. Alternatively, unset `ACCESS_EMAILS` and set a >=32-character `BETTER_AUTH_SECRET` plus either `BETTER_AUTH_BOOTSTRAP_TOKEN` or `BETTER_AUTH_OWNER_EMAIL`. Use stage-specific secrets. Runtime session/authentication behavior is unchanged. Do not export `ACCESS_AUD`; it derives from the managed application. `REQUIRE_ACCESS` may only be `1` with managed Access and cannot override the binding.
5. Smoke on the printed URL: `/app/`, `/api/setup/status` (JSON, not SPA HTML).
6. When satisfied, deploy **live** (unset `ALCHEMY_STAGE` or use exactly `live`) with live credentials and `WORKER_HOSTNAME` explicitly matching the checked-in custom domain. Other valid stage names remain isolated; underscores and empty stage names are rejected.

---

## Live deploy (Alchemy primary)

1. Copy and fill secrets (never commit):

   ```sh
   cp .env.example .env
   # Edit: CLOUDFLARE_*, WORKER_HOSTNAME, ACCESS_EMAILS or built-in auth, integration secrets
   pnpm env:load
   ```

2. **Secret semantics (one-way per environment):** Alchemy deploy **replaces** the Worker secret binding set with whatever is present in `.env` for names listed in `worker-secrets.json`. A value set only via `wrangler secret put` but missing from `.env` is **removed** on the next Alchemy deploy. Pick one store per stage: **`.env` for Alchemy**, or **wrangler-only** secrets if you never run `deploy:alchemy` on that worker name.

3. Build and deploy:

   ```sh
   pnpm build
   pnpm deploy:alchemy
   ```

4. **D1 migrations (remote)** — run on the Mac after the Worker exists:

   ```sh
   npx wrangler d1 migrations apply shiba-audit --remote --config apps/backend/wrangler.jsonc
   ```

5. Verify: Access login (if configured), `/api/setup/status`, throwaway task with publishing disabled.

### Required / optional secrets

Every name in `apps/backend/worker-secrets.json` may be bound; only configure what you use. Minimum for a coding + PR install is typically:

| Secret | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Worker-side git/PR operations |
| `AI_GATEWAY_TOKEN` | Only if your AI Gateway requires auth |
| `DASHBOARD_APPROVERS` | Emails allowed to resolve shared approvals |
| `BETTER_AUTH_SECRET` | Required for built-in dashboard sign-in when managed Access is absent; >=32 characters |
| `BETTER_AUTH_BOOTSTRAP_TOKEN` / `BETTER_AUTH_OWNER_EMAIL` | At least one required alongside built-in auth on a public stage |
| `ACCESS_AUD` | Derived automatically from the stage's managed Access app; manual configuration is for the wrangler-only path |

Provider model keys belong in **AI Gateway BYOK**, not Worker secrets. Full operator tables: [Self-hosting](https://tryshiba.dev/docs/self-hosting/) and `apps/backend/.dev.vars.example`.

### Binding and secret inventory (names only)

All declared infrastructure bindings must be available for deployment even when the feature using them is idle. Secrets remain optional unless their feature/authentication lane is selected. `apps/backend/worker-secrets.json` remains the canonical secret-name list; no values belong in this inventory.

| Category | Binding names |
| --- | --- |
| Core state and sandbox | `CodingOrchestrator`, `OpenCodeAgent`, `Sandbox`, `Automations`, `Mailbox`, `Memory`, `Waitlist`, `ModelConfig`, `LocalDispatch`, `ChatGptAuth`, `UserProviderOAuth` |
| Assets and compute | `ASSETS`, `AI`, `LOADER`, `BROWSER` |
| Storage and limits | `AGENT_TOKENS`, `AGENT_AUDIT`, `ATTACHMENTS`, `MEMORY_VECTORS`, `MCP_RATE_LIMIT` |
| Email transport | `SEND_EMAIL` |

| Feature/lane | Secret names |
| --- | --- |
| Built-in dashboard authentication | `BETTER_AUTH_SECRET`, `BETTER_AUTH_BOOTSTRAP_TOKEN`, `BETTER_AUTH_OWNER_EMAIL` |
| GitHub operations (token or App credentials); webhook verification | `GITHUB_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_REPO_INSTALLATIONS`, `GITHUB_WEBHOOK_SECRET` |
| Shared approval authorization | `DASHBOARD_APPROVERS` |
| Gateway/model and provider connections | `AI_GATEWAY_TOKEN`, `MODEL_CREDENTIAL_KEY`, `TYPESAFE_API_KEY`, `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` |
| Deployment subscription lanes | `CLAUDE_SUBSCRIPTION_TOKEN`, `CODEX_SUBSCRIPTION_AUTH_JSON`, `CURSOR_SUBSCRIPTION_TOKEN` |
| Local runtime/pairing/internal identity | `LOCAL_ADAPTER_TOKEN`, `PAIRING_SECRET`, `INTERNAL_SIGNING_KEY` |
| Slack | `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APPROVERS`, `SLACK_CHANNEL_REPOS` |
| Telegram and Discord | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY` |
| Linear | `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `LINEAR_OAUTH_ACCESS_TOKEN`, `LINEAR_DEFAULT_REPO_URL` |
| Gmail | `GMAIL_CLIENT_SECRET`, `GMAIL_TOKEN_KEY` |
| Automation triggers | `TRIGGER_TOKEN` |

Per-account subscription suffix secrets and per-MCP credential secrets are runtime-resolved names outside the base manifest. Provision them only for enabled connections. `SANDBOX_IMAGE`, when supplied, must use `registry.cloudflare.com/<CLOUDFLARE_ACCOUNT_ID>/...`; cross-account image overrides fail preflight.

---

## Rollback (wrangler only)

When Alchemy is broken or you need an emergency script-only deploy:

```sh
pnpm build
# Secrets: repeat for each name in apps/backend/worker-secrets.json you use
npx wrangler secret put GITHUB_TOKEN --config apps/backend/wrangler.jsonc
# ...
npx wrangler d1 migrations apply shiba-audit --remote --config apps/backend/wrangler.jsonc
npx wrangler deploy --config apps/backend/wrangler.jsonc
```

Wrangler keeps **undeclared** existing secrets (`keepSecrets`); it does **not** create Access applications — configure Access manually before exposing a public hostname. After changing `wrangler.jsonc` bindings, update `alchemy.run.ts` and run `pnpm check:deploy` before the next Alchemy release.

---

## Sandbox SDK 1.0 — one-way door

Production today pins **`@cloudflare/sandbox@0.12.9`** behind `apps/backend/src/sandbox/interface.ts` (`SandboxOps`). A future **Sandbox SDK 1.0** upgrade is a **container image + adapter** change, not a Worker binding rename:

- Rebuild and push the Sandbox Docker image (`apps/backend/Dockerfile`).
- Swap the factory behind `SandboxOps` / `acquireSandboxOps` (see comments in `sandbox/interface.ts` and `preview/port-gateway.ts`).
- Run full backend tests and a live sandbox smoke on **staging** before live.

Do not flip SDK major versions in the same deploy as DO migration tag changes or binding edits; treat SDK migration as its own release with rollback via the previous image tag (`SANDBOX_IMAGE` or wrangler `containers[].image`).

---

## Durable Object migrations

Tags in `wrangler.jsonc` `migrations` are **append-only**. Never edit or remove a tag already applied in production. Alchemy emits provider tags for new classes; wrangler must list every tag the published script has ever carried (including `alchemy:v*` placeholders) so rollback deploys do not re-apply history.

List applied migrations:

```sh
npx wrangler migrations list --config apps/backend/wrangler.jsonc
```

---

## Related docs

- Operator guide: `apps/web/src/content/docs/docs/self-hosting.md`
- Alchemy review notes: `ALCHEMY-REVIEW.md`
- Architecture: `ARCHITECTURE.md`
