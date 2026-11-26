# Contributing to Shiba

Thank you for helping build Shiba, an **open-source, self-hostable** workspace for AI employees. This file is the entry point; the detailed guide lives in the docs site.

## Before you open a PR

1. Read the [product contract](docs/product/ai-employees.md) and the [security and authority model](docs/architecture/security-model.md), especially **no credentials in containers** and **human approval before execution**.
2. Run the repository gate from the root:

   ```sh
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm lint:imports
   pnpm test
   pnpm build
   pnpm test:built
   pnpm check:ci
   pnpm env:load && pnpm env:scan
   ```

   Knip rejects new findings by category, file, and name. When you fix a
   listed finding, remove its entry from `knip-baseline.jsonl`.
   Run `pnpm check:knip --list` to list the current findings without updating the baseline.

3. When you touch Worker bindings or secrets documentation:

   ```sh
   pnpm check:deploy
   node scripts/check-dev-vars-example.mjs
   ```

   Binding contract: edit **`apps/backend/wrangler.jsonc` first**, then mirror `alchemy.run.ts`. Secret names: keep **`apps/backend/worker-secrets.json`** in sync with `secrets([...])`. Owner deploy steps: **`docs/DEPLOY.md`**.

4. When you change docs under `apps/web/src/content/docs/`:

   ```sh
   pnpm docs:check
   ```

5. **Do not** commit secrets, `.dev.vars`, or `.env`. Keep `.dev.vars.example` in sync (`check-dev-vars-example.mjs`).

## Docs and claims

- Write behavior from **source** (`apps/backend/src/`, `wrangler.jsonc`, `env.ts`), not stale README prose.
- Distinguish **unit tests**, **local `wrangler dev`**, and **cloud-live** evidence; cite dated entries in **`VERIFICATION.md`**.
- Do not claim production readiness without verify-shiba or equivalent live evidence.

Extended contributor guide: [https://tryshiba.dev/docs/contributing/](https://tryshiba.dev/docs/contributing/) (source: `apps/web/src/content/docs/docs/contributing.md`).

## License

Contributions are accepted under **AGPL-3.0-only** (see `LICENSE`). By submitting a PR, you agree your contribution is licensed the same way.
