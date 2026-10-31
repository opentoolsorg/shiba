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

The recovery CLI copies the complete **local Wrangler v3 persistence tree**, including SQLite databases, WAL files and object blobs. It never starts a Worker, resumes work, contacts Cloudflare, or copies configuration implicitly. Prerequisites: installed project dependencies, Node, native `sqlite3`, and `lsof` (macOS/Linux). Restore requires the exact Wrangler version recorded by the backup; keep the matching lockfile and runtime available.

Stop every local Worker, daemon, CLI, viewer and other process using the chosen persistence directory. Keep them stopped throughout backup or restore. `--offline` acknowledges this cooperative maintenance window. The tool rejects detected open files and rehashes the source before/after copying, but `lsof` is **not a lock** against a service starting after inspection. Do not use this as a live snapshot mechanism.

Choose explicit paths; both output directories below must be absent. No default store is discovered or backed up automatically:

```sh
mkdir -p -m 700 "$HOME/shiba-backups"
node scripts/local-state-recovery.mjs backup --offline \
  .shiba/local-state "$HOME/shiba-backups/local-snapshot-001"
node scripts/local-state-recovery.mjs verify \
  "$HOME/shiba-backups/local-snapshot-001"
node scripts/local-state-recovery.mjs restore --offline \
  "$HOME/shiba-backups/local-snapshot-001" .shiba/local-state-recovered
```

The bundle contains `manifest.json` plus a raw `state/` tree. Directories have mode `0700`; files have mode `0600`. The manifest records SHA-256 and size for every file, directory inventory, file/byte/database counts and Wrangler version. SQLite `quick_check` runs read-only against disposable copies with their WAL/index sidecars, leaving the originals alone. No row values appear in the manifest or command output. Checksums detect corruption, not an attacker replacing both the data and manifest; there is no signature or built-in encryption. Keep bundles outside the repository and encrypt/protect them: stored account content and encrypted credentials can still be sensitive.

Restore verifies the entire bundle **before creating the destination**, copies only into a new isolated directory, then rechecks both copies. Existing destinations, overlapping paths, changed sources, unexpected files, links/special files, corrupt SQLite, bad hashes or unsupported versions fail. The original persistence remains in place. `.dev.vars`, `.env`, `.shiba/setup.json`, browser/desktop profiles and provider credentials are not included. Protect signing/encryption keys separately and retain the keys corresponding to the data; a raw state copy alone is not a complete installation backup.

**Do not launch the real app against restored state until an operator has reviewed pending approvals, claimed runs, schedules, Durable Object alarms and effect outboxes.** An older snapshot can resurrect work or external effects already delivered. This tool has no runtime anti-replay gate, does not resolve unknown external outcomes, and grants no approval to resume anything. Production-safe coordinated recovery remains separate work.

After that review, select the recovered root explicitly through `SHIBA_PERSIST_TO` when starting local development. Preserve the original root. To roll back this local selection, stop services again and select the original root instead; do not overwrite either tree. Changing application revisions or SQLite schemas requires a separate migration/compatibility plan.

Run the isolated recovery drill:

```sh
pnpm -C apps/backend exec vitest run test/local-state-recovery.test.ts
```

The drill seeds an actual local Wrangler Worker with Durable Object, D1 and R2 bindings, stops it, backs up state, changes that state through the bindings, restores into another root, restarts and checks the original values and binary object hash. It also selects the preserved changed root again to demonstrate rollback, and rejects open stores, missing offline acknowledgement, corruption and source changes during copying. All state/configuration is temporary and contains fixture data only. This proves local persistence mechanics, not whole-application or remote production recovery. `pnpm selfhost:smoke` remains a separate clean-boot check.

There is no coordinated remote backup/restore command for deployed D1, Durable Objects, KV, R2, Vectorize, Cloudflare configuration or external providers. User-level export/deletion, retention and orphan cleanup also remain separate operational work.

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
