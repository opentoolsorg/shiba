---
title: Local development
description: Run the dashboard, Worker, docs, and tests without overstating local or cloud evidence.
---

Use Node.js 22.13.0+ and the repository-pinned pnpm version (Corepack reads it from `package.json`). From a terminal, clone the repository and install dependencies once:

```sh
git clone https://github.com/opentoolsorg/shiba.git
cd shiba
corepack pnpm install --frozen-lockfile
```

Prove a clean local boot without credentials, Docker, model calls, or Cloudflare deployment:

```sh
corepack pnpm selfhost:smoke
```

The smoke builds the dashboard/docs, applies every D1 migration into a fresh temporary Wrangler state directory, starts a local Worker with Containers disabled, checks `/api/setup/wizard` and `/app/`, then removes the temporary data. It does not change `.shiba/local-state`, call a model provider, or prove Cloudflare-hosted features. A successful result means the local app shell and API boot; it does not mean an AI employee can execute a task.

## Worker and sandbox quickstart

**One command** (recommended): local dashboard + API + Sandbox on port **8788**. The first run opens a setup wizard (GitHub token or GitHub App, a model connection, a sandbox provider, and an optional test repository). Every step can be skipped. If Docker is not running, the wizard continues with containers disabled (`--enable-containers=false`) instead of stopping. A sandbox image build needs Docker, disk, and network.

```sh
pnpm shiba dev
```

Equivalent:

```sh
bash scripts/dev.sh
```

What it does:

1. **Setup wizard** — `pnpm shiba setup` writes a redacted `.shiba/setup.json` and merges non-secret choices into `.dev.vars`. Skip with `--skip-setup`. Non-interactive runs record skips and print the next command for each doctor warning.
2. **Prerequisites** — Node 22.13+, pnpm 10+, `wrangler` (from the repo). Docker is optional: when it is down, local containers stay off.
3. **`pnpm install`** — skipped when `node_modules` already exists (use `--skip-install` to force-skip).
4. **`pnpm build`** — assembles `app-public/` for the Worker (use `--skip-build` only if you already built).
5. **`apps/backend/.dev.vars`** — created from `.dev.vars.example` when missing; mints local-only secrets (`INTERNAL_SIGNING_KEY`, `PAIRING_SECRET`, …) **without overwriting** values you already set.
6. **Local D1** — `CI=1 npx wrangler d1 migrations apply shiba-audit --local` with persistence under `.shiba/local-state/`.
7. **Sandbox image** — `npx wrangler containers build` for `apps/backend` when local containers are on (no registry push).
8. **`wrangler dev`** — same config as production bindings, `--local-upstream localhost`, and `--enable-containers=false` when containers are off.

Preview the plan without running anything:

```sh
pnpm shiba dev --dry-run
```

Ready when:

- `curl -sS http://127.0.0.1:8788/api/setup/status` returns **JSON** (not the SPA HTML shell).
- `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/app/` returns **200**.

Open **http://127.0.0.1:8788/app/** in a browser. Loopback requests use identity `default` when Access is unset (`REQUIRE_ACCESS` / `ACCESS_AUD` / `BETTER_AUTH_SECRET` should stay unset for the simplest local gate).

**After `pnpm shiba dev` starts**, configure what you need for real coding runs:

- **`GITHUB_TOKEN`** in `apps/backend/.dev.vars` — fine-grained PAT (repo Contents + Pull requests).
- **Model access** — AI Gateway BYOK on your Cloudflare account (`GATEWAY_ID` defaults to `default`), or `AI_GATEWAY_TOKEN` when the gateway is auth-gated.
- **`npx wrangler login`** — once per machine if Wrangler must talk to Cloudflare for container registry/proxy.

After the first approved sandbox run, `docker ps` should show a container for the configured image.

**Manual steps** (same end state as the script):

```sh
pnpm install
pnpm build
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
CI=1 npx wrangler d1 migrations apply shiba-audit --local --config apps/backend/wrangler.jsonc
npx wrangler containers build -t shiba-ai-coworker-sandbox:local apps/backend --config apps/backend/wrangler.jsonc
npx wrangler dev --config apps/backend/wrangler.jsonc --port 8788 --local-upstream localhost
```

**API/dashboard smoke without OAuth or Docker** (no sandbox containers):

```sh
CI=1 npx wrangler d1 migrations apply shiba-audit --local --config apps/backend/wrangler.jsonc
npx wrangler dev --local --config apps/backend/wrangler.jsonc --port 8788 \
  --enable-containers=false --local-upstream localhost
```

Vectorize and some bindings warn in pure local mode; `/api/setup/status` and `/app/` still respond for UI wiring checks.

## What works locally

`pnpm shiba dev` uses Wrangler's local runtime. D1 migrations and local Durable Object state persist under `.shiba/local-state`; `.dev.vars` holds local-only generated secrets and any credentials you add. This supports dashboard/API development and deterministic tests with fake providers. Use Docker for local sandbox containers; without Docker, the local dev command deliberately disables containers.

| Capability | Local status | Additional requirement |
| --- | --- | --- |
| Dashboard, Worker routes, local D1 migrations and Durable Object state | Local development supported | Node, pnpm, dependencies |
| Coding task execution in a local container | Optional | Docker-compatible engine and sandbox image build; a model connection and repository access are also required for real work |
| AI inference | Not offline | Configure a supported provider or AI Gateway; model use may incur provider charges |
| Cloudflare Containers, Workers AI, Vectorize, managed Access, email delivery and public webhooks | Cloud-hosted services | Cloudflare account, enabled products, deployed bindings and any required provider credentials |
| Memory search | Not a local-only guarantee | The configured Vectorize binding and embedding/model path are required; local D1/DO persistence alone does not provide semantic search |

The repository does not bundle model weights or a local inference engine. Do not describe a local install as offline AI. Optional integrations (GitHub, Slack, Telegram, Discord, Gmail, email) stay unavailable until separately configured; unset credentials leave those paths disabled or fail closed.

## Local data backup and restore

Stop the local Worker before copying or restoring its persistence directory. A live copy can miss SQLite writes. Keep backups outside the repository, encrypt them, and restrict access: they contain conversations, task data, approvals, and other account content. `.dev.vars` can contain credentials and generated signing keys, so protect it separately and never put it in a shared backup without encryption.

On macOS/Linux, make a timestamped copy of the whole Wrangler persistence directory:

```sh
backup_dir="$HOME/shiba-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
cp -a .shiba/local-state "$backup_dir/local-state"
# Optional local operator configuration; this file may contain secrets.
cp -a apps/backend/.dev.vars "$backup_dir/dev.vars" 2>/dev/null || true
cp -a .shiba/setup.json "$backup_dir/setup.json" 2>/dev/null || true
```

To restore, stop Shiba first, preserve the current state as a rollback copy, then copy the saved directory back:

```sh
mkdir -p .shiba
backup_dir="$HOME/shiba-backups/<timestamp>"  # choose the backup made above
if [ -d .shiba/local-state ]; then
  mv .shiba/local-state ".shiba/local-state.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
fi
cp -a "$backup_dir/local-state" .shiba/local-state
if [ -f "$backup_dir/dev.vars" ]; then
  install -m 600 "$backup_dir/dev.vars" apps/backend/.dev.vars
fi
if [ -f "$backup_dir/setup.json" ]; then
  cp -a "$backup_dir/setup.json" .shiba/setup.json
fi
```

Restore `.dev.vars` only when intentionally restoring the same local installation: its signing/encryption keys must remain paired with the corresponding stored data. Start Shiba and check the dashboard plus `/api/setup/wizard`. `pnpm selfhost:smoke` is a clean-boot check, not a recovery test; it uses and deletes an isolated temporary state directory.

This file-copy procedure covers Wrangler's **local** persistence only. It does not back up a deployed installation's D1, Durable Objects, KV, R2, Vectorize, or Cloudflare account configuration. This repository does not provide a coordinated remote backup/restore command; plan and verify recovery for each enabled Cloudflare product and external provider before storing important data there.

Optional scripted harness: `.cursor/skills/verify-shiba/scripts/launch.sh` (uses `--persist-to .verify/state` and the same migrations command).

Validate local secret documentation:

```sh
node scripts/check-dev-vars-example.mjs
node scripts/validate-credentials.mjs --offline
```

For account deployment after local proof, see [Self-hosting on Cloudflare](/docs/self-hosting/).

## First local run (all apps via turbo)

Start the workspace from the repository root:

```sh
pnpm dev
```

This starts the dashboard (Vite, `http://localhost:5173/app/`), the local Worker (Wrangler, port `8788`), and the docs site (Astro, `http://localhost:4321/`). Keep this terminal open and wait for each service's ready message. Open the dashboard URL to try the UI; use the Astro URL for the docs. The Vite dev server proxies API requests and the `/agents` WebSocket connection to the Worker.

No `.dev.vars` file is needed just to start the UI. To configure optional local integrations, make a private local copy of the example and edit only the values you need:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
```

Keep `.dev.vars` local; never commit credentials. Provider keys belong in your AI Gateway BYOK configuration, not in the container. For coding tasks that launch a Sandbox container, start a compatible Docker engine first. Worker AI calls and integrations may also require account configuration and their optional credentials.

If a service fails to start, check its output in the `pnpm dev` terminal. The dashboard can render without a working Worker, but API-backed features will not work; confirm Wrangler is listening on port `8788` and that the Vite proxy can reach it. `pnpm dev` is local development only—it does not deploy anything.

## Docs

```sh
pnpm docs:dev       # docs only, at http://localhost:4321/
pnpm docs:check
pnpm docs:build
pnpm docs:preview   # built site
```

`pnpm dev` already starts the docs site; use `pnpm docs:dev` when you want only Astro. `docs:build` writes `apps/web/dist`. `pnpm build` builds the dashboard into `public`, builds/copies docs into `public/docs`, and runs docs verification. Keep that order: the dashboard build empties its output directory.

## Local verification versus live behavior

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

Unit tests primarily use fakes and do not prove provider inference or cloud behavior. The dated 2026-09-19 local end-to-end record covers OpenCode under local `wrangler dev` plus a real Docker container, but the provider returned 401 and no model inference succeeded. The latest 2026-09-24 `VERIFICATION.md` records no cloud end-to-end run and deployment pending. Do not claim live model execution, browser interactions, or deployment success from static builds, mocked tests, or a dry run.
