# Shiba QA report — Devin-style agent

**Date:** 2026-10-21
**Branch:** `cursor/qa-devin-style-agent-5097`
**Tester:** cloud agent on a Linux VM (Node 22.23.3, pnpm 10.34.4)
**Scope:** Does the open-source tree behave as a Devin-style cloud coding agent today: install, configure, accept a task, plan, edit in a sandbox, run commands, produce a diff/PR, and fail honestly?

This file is the test plan and the execution log. Pass/fail is filled in after each case. Commands, logs, and screenshots are cited by path.

## What the repo claims

Shiba is an **open-source, self-hosted, account-owned AI software engineer** (README, `spec/GOAL.md`). It is not a hosted multi-tenant Devin clone.

Claimed user journey:

1. Clone, `pnpm install`, configure an account-owned AI Gateway (or BYOK) and an optional GitHub token.
2. `pnpm run deploy` (Alchemy) or `pnpm shiba dev` locally.
3. Open one Worker-served dashboard.
4. Enter a GitHub repo URL and a coding task.
5. Review a frozen approval card. Nothing runs until a human approves.
6. An orchestrator (`CodingOrchestrator`, Workers AI) plans and delegates `delegate_coding_task`.
7. An ephemeral Cloudflare Sandbox container clones the repo and runs one harness CLI (default OpenCode; also Claude Code, Codex, Devin, Grok, Pi).
8. The dashboard shows progress, changed files, and a unified diff.
9. Optional: publish a branch and pull request from the Worker (token never enters the container).
10. Extra surfaces: Slack, Telegram, Discord, Linear, email, MCP, automations, a parked desktop app.

The repo's own status line (README, `apps/web` product-status page, `VERIFICATION.md`): **deployed prototype, not production-ready. No live end-to-end cloud coding run is claimed.** The last recorded local container exercise (2026-09-19) reached provider egress and failed with HTTP 401 before inference.

Architecture (as built, `ARCHITECTURE.md`): one Cloudflare Worker, nine Durable Objects, deny-by-default egress, secrets stay outside the container, per-surface auth. Default models: orchestrator `@cf/meta/llama-3.1-8b-instruct` (Workers AI), coding `google/gemini-3.5-flash-lite` via AI Gateway. Runtime default `sandbox`, instance `standard-1`, concurrency cap 5.

## Environment for this run

| Item | This VM |
| --- | --- |
| Docker | not installed / daemon down — real Sandbox containers cannot start |
| `CLOUDFLARE_API_TOKEN` / `wrangler login` | absent — no remote AI binding, no deploy |
| `GITHUB_TOKEN` | absent |
| Provider keys (`AI_GATEWAY_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEVIN_API_KEY`, …) | absent |
| Loopback auth | `REQUIRE_ACCESS` and `BETTER_AUTH_SECRET` unset → identity `default` on localhost only |

Cases that need a live model, Docker, or GitHub are recorded as **blocked**, not as product failures, unless the product fails to say so.

## Test plan

| ID | Journey | Steps | Pass criteria |
| --- | --- | --- | --- |
| I1 | Install | `pnpm install` from a clean tree | Exit 0, lockfile respected |
| I2 | Typecheck | `pnpm typecheck` | Exit 0 |
| I3 | Lint | `pnpm lint` and `pnpm lint:imports` | Exit 0 |
| I4 | Unit/integration tests | `pnpm test` | Exit 0; record pass/skip counts |
| I5 | Production build | `pnpm build` | Dashboard + docs assemble; `docs:verify` exit 0 |
| I6 | Built-asset test | `pnpm test:built` | Exit 0 |
| I7 | CI static check | `pnpm check:ci` | biome + knip within budget |
| I8 | Deploy drift | `pnpm check:deploy` | alchemy/wrangler bindings match |
| I9 | Secret scan | `pnpm env:load && pnpm env:scan` | schema valid, no leaked secrets |
| I10 | Wrangler dry-run | `npx wrangler deploy --dry-run` | Documented to need Docker; record the actual error |
| C1 | CLI dry-run | `pnpm shiba dev --dry-run` | Prints the local plan, does not deploy, does not print secrets |
| C2 | Doctor | `pnpm shiba doctor` (or setup status) | Names missing GitHub, model, and Docker without crashing |
| C3 | Dev vars example | `node scripts/check-dev-vars-example.mjs` and `node scripts/validate-credentials.mjs --offline` | Exit 0 |
| S1 | Worker startup | `wrangler dev --local --port 8788 --enable-containers=false --local-upstream localhost` after local D1 migrations | Process stays up |
| S2 | Ready probes | `GET /api/setup/status` is JSON; `GET /app/` is HTML 200; `GET /api/whoami` is JSON | Not the SPA shell on `/api/*` |
| S3 | Config surface | Read setup status booleans | `github.token=false`, `gateway.token=false`, harness/model defaults shown, no secret values echoed |
| T1 | Task intake validation | `POST /api/runs` with bad JSON, missing repo, non-GitHub URL | 400 with a clear error; no run row |
| T2 | Queue a task | `POST /api/runs` `{repoUrl, task, baseBranch, publishPullRequest:false}` | 200 and a pending approval id; `GET /api/runs` still empty (nothing executing) |
| T3 | PR without token | Same body with `publishPullRequest:true` | 400 naming `GITHUB_TOKEN`; no approval left pending |
| T4 | Approval queue | `GET /api/approvals` | The T2 card is listed with frozen repo, task, branch |
| T5 | Reject | Reject the T2 approval | Terminal rejected; `GET /api/runs` does not show a started sandbox |
| T6 | Approve without sandbox | Queue again, approve | Honest failure (no container / no model). Must not report `completed` with an empty diff |
| T7 | Planning chat | Open the task composer and send via the UI (orchestrator LLM) | Either a real plan+approval card, or a clear error that Workers AI / AI Gateway is unconfigured |
| E1 | Sandbox edit + tests | Approve a task against a public toy repo with Docker + a model key | Clone, edit, command/test output, unified diff |
| E2 | Browse | If the harness/browser path is on | A page fetch or an explicit "not available" |
| E3 | Diff / branch / PR | `publishPullRequest:true` with `GITHUB_TOKEN` | Branch + PR URL, deletions shown as deletions |
| U1 | Dashboard shell | Open `/app/` with the worker up | Tasks composer, nav, setup/doctor visible; no crash |
| U2 | Composer gates | Empty task, empty repo, then both filled | Send stays disabled until task and repo are non-empty |
| U3 | Runs / Approvals views | After T2 | Approval visible in the Approvals view; Runs stays empty or shows only post-approval rows |
| U4 | Error states | Worker down vs worker up | Document JSON-parse banner when the API is absent; clean data when it is up |
| X1 | Error honesty | Invalid methods, unknown run id, clear registry | 404/405 JSON, no stack traces with secrets |

## Results

Execution on this VM stopped at the product bugs below. Docker, Cloudflare credentials, and provider keys are not available here, so I1–I10, a live sandbox edit, and a real vendor OAuth click were not completed in this environment. The auth and provider fixes are covered by unit tests named in the notes. Operator steps for the live deploy are in `docs/FIX_GUIDE.md`.

| ID | Result | Note |
| --- | --- | --- |
| I1–I10, C1–C3, S1–S3, T1–T7, E1–E3, U1–U4, X1 | not run end to end on this VM | No Docker daemon, no Cloudflare token, no model key. Do not treat that as a product pass. |
| Auth hang | fail on the live site, fix in this branch | Button stayed on Working because the client had no deadline. Worker auth now returns 504 at 12s. The form shows an error at 15s. Tests: `better-auth.test.ts`, `AuthScreen.test.tsx`, `auth-timeout.test.ts`. |
| Shell flash and blank paint | fail on the live site, fix in this branch | Logged-out `/app/` rendered the composer and toasted 401s. First paint is now "Checking your session…". Private routes, including `/api/setup/status`, stay gated. |
| First account on a public URL | fail on the live site, fix in this branch | Public sign-up now requires `BETTER_AUTH_BOOTSTRAP_TOKEN` or `BETTER_AUTH_OWNER_EMAIL`. Loopback dev does not. |
| Provider Open / Finish | fail on the live site, fix in this branch | Live cards used a local code and a homepage URL. Codex device grant and Claude `code#state` now reach Connected, and egress attaches the bearer. Tests: `provider-login.test.ts`, `ProvidersView.test.tsx`. Gemini, OpenCode, and Grok stay on `AI_GATEWAY_TOKEN`. |

Live probe (2026-10-21, no account created by the probe): `GET /api/whoami` 401 `better_auth` in ~4s, so the secret is set. `POST /api/auth/sign-in/email` for a different address returned 401 in ~4s, so D1 answered. Whether `shiba-qa-test@example.com` was inserted is unknown until the D1 query in `docs/FIX_GUIDE.md`.
