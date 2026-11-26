# shiba

Shiba is a self-hosted, approval-first workspace for AI employees. Start with the [product contract](docs/product/ai-employees.md) and [architecture](ARCHITECTURE.md). See `PLAN.md` for dated implementation plans, `VERIFICATION.md` for evidence, and `VERIFICATION_PLAN.md` for open gaps and how to check them.

```bash
# Gate — always required:
pnpm typecheck && pnpm lint && pnpm lint:imports && pnpm test && pnpm build && pnpm test:built
pnpm check:ci                    # the CI biome-knip job: agent context budgets, Biome lint, and the exact Knip baseline
pnpm env:load && pnpm env:scan   # varlock: validate .env against .env.schema; scan for leaked secrets
# Second tier — only where a Docker daemon is running:
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

## Agent skills

### Issue tracker

Tasks are `T<n>` sections in `PLAN.md`; state lives in its §2.0 table, evidence in `VERIFICATION.md`. See `apps/web/docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, recorded as a `Status:` word in the §2.0 table. See `apps/web/docs/agents/triage-labels.md`.

### Domain docs

See the [domain guide](apps/web/docs/agents/domain.md) for the glossary, ADRs, and standing constraints retained from the original coding spine.
