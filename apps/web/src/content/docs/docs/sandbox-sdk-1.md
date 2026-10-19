---
title: Sandbox SDK 1.0 migration
description: Phase 2a — move shiba from @cloudflare/sandbox 0.12 to 1.0 with outbound handlers and a custom Sandbox Durable Object.
---

Shiba run sandboxes now use **Sandbox SDK 1.0**: your Worker owns a `Sandbox` Durable Object that calls `this.ctx.container` for exec, files, previews, and snapshots. The npm package supplies `Files` helpers only; egress stays in the Worker via `SandboxOutbound` and [`egress.ts`](https://github.com/princepal9120/shiba/blob/main/apps/backend/src/egress.ts).

## Local rehearsal (required before production)

1. `pnpm install && pnpm build`
2. Docker running; `npx wrangler dev --config apps/backend/wrangler.jsonc`
3. Run the verify-shiba skill features `task-submit-and-approval` and `sandbox-run-and-diff` (see the repo `.cursor/skills/verify-shiba/`).

## Deferred staging deploy (owner Mac only)

Production migration is **one-way** per [Cloudflare guidance](https://developers.cloudflare.com/sandbox/sdk/migrate/plan-the-move/). Do **not** deploy 1.0 to the live `shiba-ai-coworker` Worker until local verify-shiba passes.

When ready:

1. Create a **staging Worker** (for example `shiba-ai-coworker-sandbox-staging`) with the same bindings but a **renamed container app** in `wrangler.jsonc` `containers[].name`.
2. `npx wrangler deploy --config apps/backend/wrangler.jsonc` against that staging name (never from cloud agents).
3. Run verify-shiba `pr-publish` and `review-findings` against staging with a throwaway repo.
4. Cut over production only after evidence is recorded in `VERIFICATION.md`.

## Security invariants (unchanged)

1. Human approval before any container starts.
2. No GitHub token or provider key inside the container.
3. Deny-by-default egress with per-run `allowedHosts` narrowing.
4. GitHub scoped to one approved repo path per run.
5. Worker-side review post — containers remain read-only for GitHub writes.

## Pins

| Component | Version |
| --- | --- |
| `@cloudflare/sandbox` | 1.0.1 |
| `wrangler` | ≥ 4.136.0 (repo pins 4.140.0) |
| `sandbox-shim` in Dockerfile | Copied from `cloudflare/sandbox:1.0.1` |
