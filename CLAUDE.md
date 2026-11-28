# Shiba

Read and follow [`AGENTS.md`](AGENTS.md) first. It is the canonical agent and
contributor contract for this repository. The nested `AGENTS.md` nearest to the
files you edit applies next.

For product or architecture work, start with the
[product contract](docs/product/ai-employees.md) and
[architecture map](ARCHITECTURE.md). Treat `PLAN.md`, `VERIFICATION.md`,
`ROADMAP.md`, and `docs/verification/` as dated records. Open only the section
needed for a task id, acceptance question, or historical claim; do not use them
as the current architecture by default.

## Validation gate

Run the required gate for the change before opening or merging a PR:

```bash
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built
pnpm check:ci
pnpm env:load && pnpm env:scan
```

Run the Wrangler dry run only where a Docker daemon is available:

```bash
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

Shiba CI is label-gated. Follow the label rules in `AGENTS.md` and
`CONTRIBUTING.md`; do not opt every PR into expensive validation by default.
