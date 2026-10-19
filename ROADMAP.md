# Shiba product roadmap (honest status)

**Revision:** 2026-10-19. Complements the historical task tracker in [`PLAN.md`](./PLAN.md) (T-rows, rev 12). **Evidence for “done in code”** is grep-able paths below; **live verification** is only what [`VERIFICATION.md`](./VERIFICATION.md) records with a dated entry.

## Shipped in tree (Phase 1–6 arc)

| Phase | What it is | In code (entry points) | Live E2E verified? |
| --- | --- | --- | --- |
| **1 — Core loop** | Task → approval → sandbox run → diff → optional PR → optional chained review round | `apps/backend/src/agents/orchestrator.ts` (`reviewAfterPublish`, `reviewRounds`, `failReviewRound`); dashboard Tasks panels per `apps/web/src/content/docs/docs/review.md` | **Partial.** Mock GitHub + UI in `VERIFICATION.md` (2026-10-19). Real container + model + live GitHub: **not** verified in CI/cloud VM. |
| **2a — Sandbox SDK 1.0** | Custom Sandbox DO + `SandboxOutbound` Worker entrypoint; `@cloudflare/sandbox@1.0.1` | `apps/backend/package.json` (`@cloudflare/sandbox`); `apps/backend/src/sandbox/durable-object.ts`, `outbound-entrypoint.ts`; docs `apps/web/src/content/docs/docs/sandbox-sdk-1.md` | Unit + wrangler tests; **not** a recorded live container run on SDK 1.0 in `VERIFICATION.md`. |
| **2b — Den / pack** | Long-lived den coordinator per user slug; pack spawn; subagent tree in UI (legacy `captain` API aliases) | `packages/shared/src/den.ts`; `apps/backend/src/den-routes.ts` (`/api/dens/`); `apps/frontend/src/components/SwarmDeskView.tsx`, `SubagentTree.tsx` | API + UI unit tests; **not** live multi-sandbox pack run verified. |
| **3 — Browser E2E evidence** | Agent-authored plans → Workers Browser Rendering frames → R2 manifest linked from PR body | `apps/backend/src/browser-e2e/capture.ts`; `opencode-input.ts` E2E fields; `captureRunPreview` in `screenshot.ts` | Code + `apps/backend/test/browser-e2e.test.ts`; **not** live frame capture verified. |
| **4 — Review depth / PR lifecycle** | Finding triage, merge approval queue, review retry; `review-loop` endpoint stub | `orchestrator.ts` triage route; `apps/backend/src/v1/pulls.ts` (`review-loop` → 501 on PATCH); `docs/proposals/ReviewDO.md` (future split) | Mock GitHub journeys in tests; **re-run reviewer on retry** in product: retry posts same round (`review.md`); **review-loop** multi-round: **not implemented**. |
| **5 — Integrations** | Linear webhook, automations hardening, Slack/GitHub probes | `apps/backend/src/linear/routes.ts` (`POST /api/linear/webhook`); `apps/backend/test/phase5-integrations.test.ts` | **NOT VERIFIED** live (no workspace creds in `VERIFICATION.md` 2026-10-19). |
| **6 — Public API + SDK** | `/api/v1/*`, OpenAPI, `shk_` keys, `@shiba/sdk` package | `apps/backend/src/v1-routes.ts`; `packages/sdk/` | Unit tests (`v1-phase6.test.ts`, etc.); **not** external client live proof. |
| **BYOM / connections** | Deployment-scoped model connections, purpose pins, gateway route freeze on approve | `apps/backend/src/model-policy.ts`, `model-config-do.ts`; dashboard composer | Local/unit; live inference still blocked on gateway cred in older `VERIFICATION.md` entries. |
| **SIWC + fallbacks** | ChatGPT subscription via `ChatGptAuth` DO; `codex-subscription` / API-key paths; optional sandbox OAuth flag | `apps/backend/src/chatgpt-auth-do.ts`; `subscription-auth-routes.ts`; `packages/shiba-login/` CLI | Encrypted-storage tests (`subscription-auth.test.ts`); **live OAuth round trip: not verified** in `VERIFICATION.md`. `SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH` default `0` in `wrangler.jsonc`. |
| **Custom agents** | Org-scoped agent presets (harness, model, sandbox defaults) | `apps/backend/src/custom-agents-routes.ts` (`/api/custom-agents`); `CustomAgentsView.tsx` | `apps/backend/test/custom-agents.test.ts`; no public docs page yet. |
| **Pluggable sandboxes** | `cloudflare` (default), `docker-local`, `computesdk` (+ remote runner), custom registry | `packages/sandbox/`; `apps/backend/src/sandbox/provider-catalog.ts`; docs `sandbox-providers.md` | **Cloudflare:** design + local dev path. **ComputeSDK / E2B / Daytona / Modal:** adapter + matrix docs; **real backends NOT VERIFIED** for shiba invariants. |
| **Setup doctor** | Pre-run diagnostics (roles, sandbox matrix, GitHub publish, gateway) | `apps/backend/src/setup-doctor.ts`; `GET /api/setup/status`; `pnpm shiba doctor` in `scripts/shiba.mjs` | Unit tests `setup-doctor.test.ts`. |
| **Operator CLI** | `pnpm shiba dev` (local Worker + sandbox prerequisites) | `scripts/shiba.mjs`, `scripts/shiba-dev-lib.mjs` | Requires local Docker; cloud agent VM often lacks daemon (`VERIFICATION.md`). |
| **Deploy drift check** | `alchemy.run.ts` ↔ `wrangler.jsonc` bindings/secrets | `scripts/check-alchemy-drift.mjs`; `pnpm check:deploy` | Runs in CI-style gates; not a deploy. |

## Explicitly not live-verified (say this in sales copy)

- End-to-end: **real sandbox container + live model + live GitHub** on an operator-owned Cloudflare deploy (T10-class gap; see `VERIFICATION.md`).
- **ComputeSDK** providers (E2B, Daytona, Modal, etc.) wired for production egress invariants.
- **Shiba Desktop** (Electron shell, T60–T66): modules built; live window / notarized build **parked** (#126); evidence under `apps/web/docs/evidence/desktop/`.
- **Multi-round review loop** (`GET/PATCH …/review-loop`): returns `null` / 501 — not a shipped product surface.

## Next (ordered, no calendar estimates)

1. **Live E2E** — one dated `VERIFICATION.md` entry: owner account, real repo, container completes, optional PR + review on GitHub.
2. **Deploy from owner Mac** — Alchemy/bootstrap path with human OAuth; not from cloud agents (`spec/GOAL.md`).
3. **Live desktop** — signed app + STOP-A login spike on real deployment.
4. **Re-run reviewer on retry** — product behavior vs “post same round again” (see `review.md`).
5. **Review-loop endpoint** — multi-round lifecycle (today stubbed in `v1/pulls.ts`).

## Where to look

| Question | Doc |
| --- | --- |
| Task IDs and old phases | `PLAN.md` §2.0 |
| What was actually run/tested | `VERIFICATION.md`, `VERIFICATION_PLAN.md` |
| Sandbox provider matrix | `apps/web/src/content/docs/docs/sandbox-providers.md`, `packages/sandbox/adapters/COMPUTESDK-MATRIX.md` |
| Future event-sourced orchestrator | `PLAN-V2-NEXT.md` (partially superseded by shipped event spine — see `PLAN.md` §2.1) |
