---
title: Local development
description: Run the dashboard, Worker, docs, and tests without overstating local or cloud evidence.
---

Use Node.js 22.13.0+ and pnpm 10+. From a terminal, clone the repository and install dependencies once:

```sh
git clone https://github.com/princepal9120/shiba.git
cd shiba
pnpm install
```

## Worker and sandbox quickstart

**One command** (recommended): local dashboard + API + Sandbox on port **8788**. Requires **Docker running**, enough disk for the pinned Sandbox image build, and network for the first `pnpm install` / `pnpm build`.

```sh
pnpm shiba dev
```

Equivalent:

```sh
bash scripts/dev.sh
```

What it does:

1. **Prerequisites** — Node 22.13+, pnpm 10+, `wrangler` (from the repo), Docker daemon reachable.
2. **`pnpm install`** — skipped when `node_modules` already exists (use `--skip-install` to force-skip).
3. **`pnpm build`** — assembles `app-public/` for the Worker (use `--skip-build` only if you already built).
4. **`apps/backend/.dev.vars`** — created from `.dev.vars.example` when missing; mints local-only secrets (`INTERNAL_SIGNING_KEY`, `PAIRING_SECRET`, …) **without overwriting** values you already set.
5. **Local D1** — `CI=1 npx wrangler d1 migrations apply shiba-audit --local` with persistence under `.shiba/local-state/`.
6. **Sandbox image** — `npx wrangler containers build` for `apps/backend` (no registry push).
7. **`wrangler dev`** — same config as production bindings, containers on when Docker is up, `--local-upstream localhost`.

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
