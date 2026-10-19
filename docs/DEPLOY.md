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
- `npx wrangler login` **or** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in gitignored root `.env` (validated by `pnpm env:load`)

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

3. Staging gets **suffixed** worker, container, and datastore names and **workers.dev** enabled. It does **not** attach `app.tryshiba.dev` or managed Access apps.
4. Smoke on the printed URL: `/app/`, `/api/setup/status` (JSON, not SPA HTML).
5. When satisfied, deploy **live** (unset `ALCHEMY_STAGE` or use a `live*` stage per `alchemy.run.ts`) with the same `.env` secret set.

---

## Live deploy (Alchemy primary)

1. Copy and fill secrets (never commit):

   ```sh
   cp .env.example .env
   # Edit: CLOUDFLARE_*, ACCESS_EMAILS, WORKERS_SUBDOMAIN, integration secrets
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
| `ACCESS_AUD` | Set automatically on live Alchemy deploy when Access is managed; otherwise set manually with `REQUIRE_ACCESS=1` |

Provider model keys belong in **AI Gateway BYOK**, not Worker secrets. Full operator tables: [Self-hosting](https://tryshiba.dev/docs/self-hosting/) and `apps/backend/.dev.vars.example`.

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
