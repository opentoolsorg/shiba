# Capy and Hoplite OSS parity plan

> **For Hermes:** Implement with the swarm-desk contract at `spec/CONTRACTS.md`. One parent integration after the eight exclusive files exist. One commit and one pull request, made by the parent, not by a leaf agent.

**Goal:** Ship a self-hosted Shiba swarm desk that matches the Capy and Hoplite workflows we can actually run on the current Cloudflare architecture: four lanes, Captain/Build/Review mapped onto existing roles, Linear and Sentry paste, and stateless share links.

**Architecture:** Project `DelegatedRun` records that already live on `CodingOrchestrator`. Do not add a Durable Object, do not raise `max_instances`, and do not edit `orchestrator.ts`. Share links are HMAC tokens (`SWARM_SHARE_SECRET`) so the link is the capability. Intake is a pure parser plus `POST /api/swarm/intake` so existing webhook automations can normalize Linear and Sentry JSON without a new trigger kind.

**Tech stack:** pnpm + turbo monorepo, `@shiba/backend` Worker, `@shiba/frontend` TanStack Start (`@tanstack/react-start` ^1.168.58, `@tanstack/react-router` ^1.170.39), `@shiba/shared` zod-free pure TypeScript for this slice, Vitest 5.

---

## Measured current state

- Repo `/Users/princepal/Desktop/test/ai-intern`, branch `security/audit-fixes`, remote `https://github.com/princepal9120/ai-intern.git`.
- Working tree at measurement time: only `.gitignore` modified. Do not revert or extend that unless the diff is ours.
- Dashboard nav already has Dashboard, Tasks, Activity, Analytics, Diff, Approvals, Providers, Skills, Agents and MCP, Mailbox, Memory, Automations, Integrations, Remote Access, Settings.
- Run statuses: `pending`, `running`, `completed`, `error`, `aborted`, `cancelled`, `unknown`. There is no backlog or archived status. Lanes are a projection.
- Roles already: `orchestrator`, `explorer`, `fixer`, `reviewer`, `designer` (`packages/shared/src/roles.ts`). `CodingOrchestrator` never edits the repo itself (`spec/GOAL.md`).
- Automations already: schedule, github, slack, webhook, manual (`apps/backend/src/automations.ts`).
- Preview already: one PNG via `exposePort` on port 8080 (`apps/backend/src/screenshot.ts`). No video, no Sentry client, no Linear client.
- Web sessions: up to 100 named sessions per user. Sandbox `max_instances` is 5.
- `spec/GOAL.md` still forbids Queues, Workflows, Hono, and a tenth store. This plan does not reopen that.
- OpenCode CLI 1.18.34 is installed. `opencode/gemini-3.8-flash` and the title model `opencode/gpt-5.4-nano` returned `Insufficient account funds` on 2026-10-14T22:09:10Z. Do not launch a swarm on the `opencode` provider until a one-agent smoke writes a file.

## Parity matrix

| Surface | Capy / Hoplite | Shiba today | This slice |
| --- | --- | --- | --- |
| Four task lanes | Capy backlog / in progress / needs review / archived | Runs list with raw statuses | Project lanes in the dashboard |
| Captain / Build / Review | Capy modes | Roles orchestrator / fixer / reviewer | Map, do not add a role |
| Parallel cloud agents | Both advertise many at once | 100 session records, 5 sandbox instances | Show the queue. Do not pretend the cap is higher |
| Share link | Hoplite one-click handoff | None | HMAC GET, no new store |
| Linear | Both | None | Paste URL or `KEY-n: title`, plus webhook JSON normalize |
| Sentry | Hoplite issue to thread; Capy import | None | Paste URL and webhook JSON normalize |
| Slack, GitHub, cron, webhook | Both | Implemented | Keep |
| BYOK and subscription harnesses | Capy external subscriptions | AI Gateway egress plus flag-gated harnesses | Keep. No new harness |
| Live preview | Hoplite preview URL and video | PNG screenshot | Show `screenshotUrl`. Do not claim video |
| VM snapshots, docker-in-docker, desktop view | Capy machines doc | Not present | Not in this slice |
| SSO, credits, SOC 2, Mac app | Their paid/cloud product | Not present | Not in this slice |

## Model routing

The user asked for UI on Antigravity, daily coding on `gemini-3.8-flash`, review on Grok, the plan on ChatGPT Sol, and Luna through opencodex.

| Work | Model id |
| --- | --- |
| This plan, if a funded opencodex smoke passes first | `opencodex/gpt-6.1-sol` |
| Luna check (one file, throwaway dir) | `opencodex/gpt-6-luna` |
| Implementation agents | `opencodex/google-antigravity/gemini-3.8-flash` |
| Review pass | `opencodex/cursor/grok-4.7` |

`opencode/gemini-3.8-flash` is the requested daily coder and it is not usable until the OpenCode account has funds. Antigravity Gemini on the opencodex provider is the funded-path substitute, and only after its own one-agent smoke writes a file.

## Fleet

`/goal` and `/subagents` are not installed skills. The installed procedure is `fleet-agent-orchestration` plus `parallel-agent-build`: smoke one agent, then fan out exclusive files, about ten processes at a time, each with `terminal(background=true)`.

This contract has eight exclusive files. Launching one hundred writers onto `orchestrator.ts` or `app.tsx` would corrupt the tree. One hundred agents is the session cap Shiba already has (`MAX_SESSIONS_PER_USER`), not one hundred writers on the same files. Launch the eight owners after the smoke. A review agent runs after their tests pass. The parent integrates, typechecks, and only then makes the single commit and pull request.

## Tasks

### Task 1: Smoke one opencodex agent

Run from a throwaway directory, not the repo:

```bash
mkdir -p /tmp/oc_smoke2 && rm -f /tmp/oc_smoke2/hello.txt
opencode run -m opencodex/gpt-6-luna --auto --pure --print-logs --dir /tmp/oc_smoke2 "Create a file named hello.txt whose entire contents are smoke-ok followed by a newline. Do not create any other file."
```

Expected: exit 0 and `hello.txt` contains `smoke-ok`. If this fails, do not start the eight. Try `opencodex/google-antigravity/gemini-3.8-flash` once. If that also fails, stop the fleet and report the error. Do not fall through to a free model for this repo.

### Task 2: Agents A-H

Each agent prompt starts with: read `spec/CONTRACTS.md`, write only your files, run only your test file, write `.build/status/agent<LETTER>.done`.

- A and D can be parallel. D's tests import A's module, so if A is late, D still writes the tests from the contract and re-runs.
- B and E parallel, same way.
- C and F after A and B exist, because the route imports both modules. F can be written earlier against the contract.
- G and H are independent.

### Task 3: Parent integration

Add to `packages/shared/src/index.ts`:

```ts
export * from "./swarm-desk.js";
export * from "./swarm-share.js";
```

Call `handleSwarm` from `apps/backend/src/index.ts` immediately before `handleRuns`.

Add nav id `swarm` with label `Swarm` and description `Four lanes, share links, and issue paste`. Icon: reuse a lucide icon already in the file if one fits (`Columns3` only if you add it to the existing lucide import). Put `swarm` in the Workspace group after `tasks`.

Mount `SwarmDeskView` from `app.tsx` when `mainView === "swarm"`. Pass the runs already loaded for the tasks view. `onApplyIntake` writes the composer task. `shareUrlFor` POSTs `/api/swarm/share` with the same credentials mode as the existing `/api/runs` fetch.

Sidebar: `{ label: 'Swarm desk', slug: 'docs/swarm-desk' }` in the Operate group.

### Task 4: Verify

```bash
pnpm --filter @shiba/backend exec vitest run test/swarm-desk.test.ts test/swarm-share.test.ts test/swarm-routes.test.ts
pnpm --filter @shiba/shared typecheck
pnpm --filter @shiba/backend typecheck
pnpm --filter @shiba/frontend typecheck
```

Expected: the three vitest files pass, and the three typechecks exit 0.

### Task 5: One commit, one PR

Parent only, after Task 4 is green. Do not include `.hermes/` or `.build/` (both gitignored). Do not stage unrelated `.gitignore` changes unless they are required for the slice.

## Risks

- OpenCode provider balance is zero. A swarm started there fails N times.
- `app.tsx` is about 84KB. One parent edit only.
- Share tokens include `userId` so the GET can find the right Durable Object. The public JSON must not echo `userId`.
- Default `loadRun` can form an import cycle with `runs-routes.ts`. Tests inject `loadRun` so the cycle is not on the test path.
- Raising sandbox concurrency, recording video, or adding Linear OAuth would violate `spec/GOAL.md` or need credentials this repo does not have.
