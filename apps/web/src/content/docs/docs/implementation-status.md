---
title: Implementation status reference
description: The dated engineering inventory and live-verification gaps for developers and installation owners.
---

This page is the short version of the repo file `ROADMAP.md` (2026-10-19). “In code” means a path and tests exist. “Live” means a dated entry in `VERIFICATION.md` from a real account, container, model, and GitHub.

## In the tree

- Approval-gated task, sandbox run, diff, optional pull request, optional review round (`apps/backend/src/agents/orchestrator.ts`).
- Cloudflare Sandbox SDK 1.0 with `SandboxOutbound` (`apps/backend/package.json`, `apps/backend/src/sandbox/`).
- Den/pack coordinator and subagent tree (`apps/backend/src/den-routes.ts`, dashboard Swarm desk).
- Browser E2E capture code (`apps/backend/src/browser-e2e/capture.ts`).
- Review finding triage; `review-loop` PATCH returns 501 (`apps/backend/src/v1/pulls.ts`).
- Linear webhook and automations (`apps/backend/src/linear/routes.ts`).
- `/api/v1` and `@shiba/sdk`.
- Custom agents (`/api/custom-agents`).
- Sandbox providers: Cloudflare default, `docker-local`, ComputeSDK adapter (`apps/web/src/content/docs/docs/sandbox-providers.md`).
- `pnpm shiba dev`, `pnpm shiba doctor`, `pnpm check:deploy`.

## Not live-verified

- A real container plus a live model plus a live GitHub pull request on an owner deploy.
- ComputeSDK backends (E2B, Daytona, Modal, and the rest) against shiba’s egress rules.
- Slack, Telegram, Discord, and Linear against a real workspace (the landing page says “in code” for that reason).
- Electron desktop (parked; evidence under `apps/web/docs/evidence/desktop/`).

## Next

Live end-to-end on the owner’s machine, a signed desktop build, a reviewer re-run that is more than posting the same round, and a real review-loop endpoint.
