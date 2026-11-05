# Plan: Hoplite API + Capy UI parity (end to end)

Status: DRAFT, not started. Source: https://hoplite.sh/docs/api/ (OpenAPI 3.1 at /docs/openapi.json, 122 operations, 20 groups). UI/flow reference: https://capy.ai.

## 0. Facts that shape the plan

- shiba `/api/v1` today = `apps/backend/src/v1-routes.ts` (129 lines), a thin shim over `/api/runs`. It mirrors **Capy's** 9-endpoint public API (threads, message, interrupt, archive, tasks, reviews), not Hoplite's.
- Only gap vs Capy's 9: `GET /api/v1/threads/{id}/messages`.
- Hoplite is a 122-op superset. Almost all of it is missing. Hoplite paths are `/api/*` (no `/v1`); shiba keeps `/api/v1/*` and a thread = a run today.
- capy.ai has no `/docs` (404). Capy UI must be captured from the live app, not docs.
- Tooling gaps: no capy MCP loaded; `rea` browser tools need a loopback CDP endpoint (Chrome with `--remote-debugging-port=9222`); "grok-4.6" is not in the roster, `ocx-grok-4-7` is.

## 1. Gap matrix (Hoplite group -> shiba)

| Group (ops) | Shiba state | Work |
|---|---|---|
| System (2) health, capabilities | health exists; no `/capabilities` | add capabilities doc from harness registry |
| Threads (7) list/create/get/patch/questions/answer/compact | list/create/get only | PATCH, questions + answer (approval gate maps here), compact |
| Messages (3) list/append/export | append only (`/message`) | GET messages, export transcript, alias `/messages` |
| Runs (8) list/run-state/active/stop/retry/failure/activity/bounds | interrupt only | all 8; backed by run signals + `decideRunTransition` |
| Diffs + checkpoints (3) | `git-checkpoint.ts` (T44) exists, not exposed | expose diff, list, restore |
| Pull requests (7) create/ready/status/comments/merge/review-loop get+patch | `pullUrl` only, github.ts | all 7 on `github.ts` |
| Previews (3) | `proxyToSandbox` wired (PLAN L153) | start, get, access |
| Attachments (3) presign/confirm/download | none | R2 presign flow |
| Workspaces (3) add repo, recovery get/post | none | multi-repo thread + recovery |
| Projects (7) + repos + env vars (3) | none (runs are repo-keyed) | project entity, D1 migration, encrypted env vars |
| Repositories (4) GitHub install/repos/branches/inspect | `github-project.ts` partial | list + inspect |
| Automations (7) | `automations*.ts` exists | re-key to `/projects/{id}/automations`, executions, run |
| MCP servers (4) | `mcp-gateway`, oauth-mcp (T29) | CRUD route facade |
| Webhooks (7) + signing | none outbound | new: subscriptions, HMAC signing, deliveries, redeliver |
| Events (3) head/list/stream | SSE exists internally | durable cursor + public SSE |
| Service accounts (8) | `agent-tokens.ts` | map to service accounts + rotate |
| Billing/usage (4) | `usage` on run, costUsd | plan, summary, thread + org usage |
| Models (1) | model catalog exists | `/api/model-providers` facade |
| Operation receipts (1) | `CommandReceipt` (T41) | expose `/api/operations/{id}` + `Idempotency-Key` on writes |

## 2. Architecture decisions (need owner sign-off before code)

1. **Namespace:** serve Hoplite shapes at `/api/v1/*` (additive; keep Capy 9 stable). One router file per group under `apps/backend/src/v1/`, `v1-routes.ts` becomes the dispatcher. Reason: file is already dense; splitting avoids a 1500-line file.
2. **Thread != run:** introduce a `threads` table (id, projectId, title, status) with N runs each. Today `threadId = runId`; keep that as the first run id for back-compat.
3. **Contract-first:** vendor Hoplite `openapi.json` -> generate zod schemas in `packages/shared`; contract test fails if shiba route set drifts. Deviations get written down, not silent.
4. **Auth:** reuse `isAuthorizedRequest` + service accounts; no new auth path.
5. Single-tenant stays (spec/GOAL.md). Billing group returns plan/usage for the one org; no Stripe.

## 3. Phases

Each phase ends with the repo gate (`pnpm typecheck && lint && lint:imports && test && build && test:built`) and a VERIFICATION.md entry.

- **P0 Capture (parallel, no code).** rea: launch Chrome with CDP, log into capy.ai, `capture_browser_scenario` + `capture_web_screenshot` for: thread list, thread view (messages/tasks/diff/PR), new-thread composer, reviews lane, settings (providers/BYO subscription), integrations. Output: `docs/parity/capy-ui/*.png` + flow diagrams (mermaid) per flow: create thread -> run -> approve -> PR -> merge. Also diff hoplite OpenAPI into `docs/parity/hoplite-openapi.json`.
- **P1 Contract + core.** Vendored spec, zod gen, contract test, Threads/Messages/Runs/Models/System/Operations + `Idempotency-Key`. (~35 ops)
- **P2 Code surface.** Diffs/checkpoints, PRs, Previews, Attachments, Workspaces. (~19 ops)
- **P3 Org surface.** Projects, env vars, repositories, automations re-key, MCP facade. (~25 ops)
- **P4 Integration surface.** Events (cursor + SSE), Webhooks (HMAC, retry, redeliver), service accounts, billing/usage. (~23 ops)
- **P5 UI parity.** Rebuild frontend views against P0 captures: thread list + composer, thread detail (timeline, diff, PR panel, preview iframe), reviews lane, projects/automations/webhooks/service-accounts/env settings. Visual diff via rea `compare_web_screenshots` vs capy captures; target <= agreed pixel threshold.
- **P6 End-to-end.** Reticle/Playwright flow: create project -> thread -> run -> question -> approve -> diff -> PR -> merge -> webhook delivered. Record in VERIFICATION.md.

## 4. Worker routing (per ~/.claude routing rules)

| Work | Agent |
|---|---|
| P0 capture, UI research | `Explore` (sonnet) + rea |
| P1-P4 backend endpoints (daily coding) | `ocx-swe-2` (devin/swe-2) |
| Second implementer / parallel groups | `ocx-grok-4-7` |
| P5 frontend | `ocx-gpt-6-1-sol` (frontend row; fallback Opus) |
| Review pass after each phase | `oh-my-claudecode:code-reviewer`, `model: opus` |
| Kept on main model | thread/run schema + D1 migration, webhook signing, service-account/auth, billing/usage paths, final approval |

"Through the codex" is read as: the swe-2/grok workers run via opencodex (`ocx-*`). Say if you meant the OpenAI Codex CLI instead.

## 5. Risks

- Scope: 122 ops + full UI is multi-week; P1 alone is a shippable milestone.
- Hoplite/Capy are closed products: UI "1:1" = visual + flow parity from captures, not their code. Don't copy their assets/branding.
- `proxyToSandbox` previews + R2 attachments need real-account verification (Docker/wrangler second-tier checks).
- Webhooks introduce outbound egress + secret storage: security-review before P4 ships.

## 6. Open items for owner

1. Approve decisions in section 2 (esp. thread/run split + `/api/v1` namespace).
2. Start Chrome with remote debugging and sign into capy.ai (needed for P0 UI capture), or give screenshots.
3. Confirm "codex" meaning and that grok-4.7 replaces grok-4.6.
4. Merge into PLAN.md as T-numbered tasks once approved (repo convention).

## 7. Storage design for P3/P4 remainder (proposed, not built)

Existing: DO SQLite classes (migrations v1..v9 + alchemy:v10/v11), KV `AGENT_TOKENS`, D1 `AGENT_AUDIT`, R2 `ATTACHMENTS`.

| Hoplite group | Store | Why |
|---|---|---|
| Projects + repo bindings + env vars (13 ops) | **new DO class `Projects`**, migration `v12 new_sqlite_classes` | relational (project -> repos, env rows), single writer per org, matches Automations/Memory pattern |
| Env var values | encrypted in `Projects` with AES-GCM; new secret `PROJECT_ENV_KEY` | Hoplite says "encrypted"; never returned on read |
| Webhooks + deliveries (7 ops) | same `Projects` DO tables `webhooks`, `webhook_deliveries` | one place; delivery retry via DO alarm; HMAC-SHA256 signing secret per webhook, shown once, stored hashed-for-display + encrypted for signing |
| Service accounts + credentials (8 ops) | extend `agent-tokens.ts` on KV `AGENT_TOKENS` (add `sa_` record + credential list) | tokens already hashed-at-rest there; no new store |
| Threads registry (title, versions, questions, compaction) | `Projects` DO table `threads` keyed by runId | replaces the 501s in v1/threads.ts |
| Operation receipts read route | CodingOrchestrator DO route `/api/operations/{id}` over existing `commandReceipts` | no new storage |

Deploy impact (needs owner approval): wrangler migration `v12`, secret `PROJECT_ENV_KEY`, alchemy drift entries. Outbound webhooks add egress allowlist entries (egress.ts) and need security review before enabling.
