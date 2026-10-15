# Swarm desk contract

Every agent reads this file first. Shiba stays Shiba. This is the open, self-hosted slice of the Capy and Hoplite desk. Do not copy their names, logos, domains, or marketing sentences into product copy.

Parent integration (not an agent) wires the barrel and the dashboard after these files exist. Agents do not commit, push, or open a pull request.

## Stack lock

- TypeScript, strict, `noUncheckedIndexedAccess`.
- No new npm dependency. No new Durable Object. No edit to `apps/backend/wrangler.jsonc`. No edit to `apps/backend/src/agents/orchestrator.ts`.
- No Queues, Workflows, or Hono. The Worker router stays hand-rolled.
- Shared modules are pure TypeScript. Crypto is global `crypto.subtle` (HMAC-SHA256). Do not import `node:crypto`.
- Tests live in `apps/backend/test/*.test.ts` and import the implementation by relative path, not through the package barrel.

## What this slice is

Capy shows four task lanes (backlog, in progress, needs review, archived), three agent modes (Captain plans, Build edits, Review reads the diff), a paste box for Linear and Sentry, and a share link. Hoplite adds one-click share links and "spin a thread from the issue you already have."

Shiba already stores runs on the caller's CodingOrchestrator (`DelegatedRun` in `packages/shared/src/runs.ts`) and already caps named web sessions at 100 (`MAX_SESSIONS_PER_USER` in `apps/backend/src/web-sessions.ts`). Sandbox concurrency is `max_instances: 5` in `apps/backend/wrangler.jsonc`. This slice projects those runs. It does not raise the sandbox cap and it does not add a tenth store.

## Out of scope (do not build)

- VM snapshots, docker-in-docker, live desktop, noVNC, or video recordings. The existing preview is one PNG from `apps/backend/src/screenshot.ts` (`screenshotUrl` on the run).
- Linear, Sentry, or Vercel OAuth apps. Paste and webhook JSON only.
- SSO/SAML, credit ledgers, SOC 2, a Mac app, or a rebrand.
- Changing `RunStatus`, `AGENT_ROLES`, or `HARNESS_IDS`.

## Lane rules

`laneForRun` uses only `status` and whether `pullUrl` is a non-empty string. `pullUrl` does not move a run between lanes in this slice (completed work is always needs review, with or without a PR). The argument stays on the type so a later slice can branch on it without a rename.

| status | lane |
| --- | --- |
| `pending` | `backlog` |
| `running` | `in_progress` |
| `completed` | `needs_review` |
| `error`, `aborted`, `cancelled`, `unknown` | `archived` |

`projectSwarmDesk` places every input run in exactly one lane. Sort each lane by `updatedAt` descending, then `runId` ascending.

Card title: first line of `task`, trimmed. Empty becomes `Untitled thread`. Longer than 80 characters is sliced to 80.

## Mode rules

`roleForMode` and the reverse `modeForRole`:

| mode | role | meaning (already true in this repo) |
| --- | --- | --- |
| `captain` | `orchestrator` | Plans and delegates. `CodingOrchestrator` does not edit the repo itself. |
| `build` | `fixer` | Sandbox coding lane. |
| `review` | `reviewer` | Reads the diff. |

`modeForRole`: `orchestrator` -> `captain`, `reviewer` -> `review`, anything else including omitted role -> `build`. Do not drop runs whose role is `explorer` or `designer`.

## Intake rules

`parseSwarmIntake(text: string): SwarmIntake`

- Blank or whitespace: `{ source: "plain", title: "", prompt: "", externalId: undefined, url: undefined }`.
- A Linear issue URL (`https://linear.app/<org>/issue/<KEY>-<n>/<slug>`) wins over a bare key. `externalId` is the key (`ENG-123`). Title from the slug: hyphens to spaces, first character uppercased (`fix-the-login` -> `Fix the login`). If the slug is absent, title is the key. `url` is the trimmed input. `prompt` is `Linear ENG-123: Fix the login\n<url>`.
- A bare key line `ENG-123: Fix the login` (regex `^([A-Z][A-Z0-9]+-\d+):\s+(.+)$` on the trimmed text, single line) is `source: "linear"`. Title is the text after the colon, trimmed. `prompt` is `Linear ENG-123: Fix the login` with no URL line.
- A Sentry URL whose host is `sentry.io` or ends with `.sentry.io` and whose path contains `/issues/<digits>` is `source: "sentry"`. `externalId` is those digits. Title is `Sentry issue <digits>`. `prompt` is `Sentry <digits>: Sentry issue <digits>\n<url>`.
- Anything else is `source: "plain"`. Title is the first line trimmed. Prompt is the trimmed full text.

`normalizeSwarmWebhook(body: unknown): SwarmIntake | null`

- Non-object: `null`.
- Linear shape: object with `data.identifier` matching `^[A-Z][A-Z0-9]+-\d+$` and `data.title` a string. `source: "linear"`. Title is `data.title`. `externalId` is the identifier. `url` is `data.url` when it is a string. `prompt` is `Linear <id>: <title>` plus, when present, a newline + description and a newline + url.
- Else Sentry shape: object with `data.issue.title` a string and (`data.issue.shortId` or `data.issue.id`) a string. `source: "sentry"`. `externalId` is `shortId` when it is a non-empty string, otherwise `id`. Title is `data.issue.title`. `url` is `data.issue.permalink` when it is a string. `prompt` is `Sentry <externalId>: <title>` plus a newline + url when present.
- Else `null`.

## Share token

Canonical payload is `JSON.stringify` of exactly these keys in this order: `exp`, `runId`, `sessionId`, `userId`. `sessionId` is `null` when omitted. No whitespace. `exp` is a unix second.

Token is `base64url(utf8(canonical)) + "." + base64url(hmacSha256(secret, canonical))`. Base64url is RFC 4648 without padding.

`signShareToken(secret, claims, ttlSeconds, nowSeconds)`:

- Throws `Error` if `secret` is empty or not a string.
- Throws if `ttlSeconds` is not an integer in `[60, 604800]`.
- Throws if `runId` fails `^[A-Za-z0-9_-]{1,128}$`.
- Throws if `userId` fails `^[A-Za-z0-9_.:@-]{1,128}$`.
- Throws if `sessionId` is present and fails `^[A-Za-z0-9-]{1,128}$`.
- `exp = nowSeconds + ttlSeconds`.

`verifyShareToken(secret, token, nowSeconds)` returns the payload or `null`. `null` when the secret is empty, the token is malformed, the signature differs, `exp <= nowSeconds`, or a field fails the same checks. Compare HMAC bytes with a XOR loop, not `===` on the digest string.

Locked vector, secret `test-secret`, claims `{ runId: "run_1", userId: "user_1" }`, ttl `3600`, now `1700000000`:

- canonical: `{"exp":1700003600,"runId":"run_1","sessionId":null,"userId":"user_1"}`
- token: `eyJleHAiOjE3MDAwMDM2MDAsInJ1bklkIjoicnVuXzEiLCJzZXNzaW9uSWQiOm51bGwsInVzZXJJZCI6InVzZXJfMSJ9.2snVxPrw1POfhWfTRhq92H9iZD75ucwaHagNxwMOti0` <!-- gitleaks:allow -->

`redactShareView` copies only: `runId`, `task`, `status`, `lane`, `repoUrl`, `baseBranch`, `pullUrl` (omit the key when undefined), `screenshotUrl` (keep null), `summary` sliced to 500 characters (omit the key when undefined), `updatedAt`. Never copy `diff`, receipts, steering, approval, error, or route.

## HTTP

`handleSwarm(request, env, deps?)` returns `null` when the path is not ours.

- `POST /api/swarm/share` requires `deps.isAuthorized` (default `isAuthorizedRequest` from `apps/backend/src/request-auth.ts`). 401 `{ "error": "Authentication required." }` when false. Body `{ runId, sessionId? }`. 503 `{ "error": "Set SWARM_SHARE_SECRET to mint share links." }` when the secret is missing or blank. Read the secret as `(env as { SWARM_SHARE_SECRET?: string }).SWARM_SHARE_SECRET`. Do not edit `env.ts`. User id comes from `resolveUserId`; when it returns null, use `"default"` (same fallback as `resolveRunStoreTarget`). 400 on a bad `runId`. 200 `{ "url": "<origin>/api/swarm/share/<token>", "exp": <seconds> }` with ttl fixed at `604800`.
- `GET /api/swarm/share/<token>` does not require operator auth. The token is the capability. 404 `{ "error": "Share link is not valid." }` when verify returns null. 404 when `deps.loadRun` returns null. 200 is the redacted view. Default `loadRun` is not required to succeed in unit tests: tests inject it.
- `POST /api/swarm/intake` requires auth. Body `{ "text": string, "webhook": boolean }`. When `webhook` is true, parse with `normalizeSwarmWebhook` of `JSON.parse(text)` and 400 when that returns null or JSON.parse throws. When false, `parseSwarmIntake`. 200 is the intake object. This route exists so a webhook automation can normalize without a new trigger kind.

Deps type:

```ts
export interface SwarmRouteDeps {
  isAuthorized?: (request: Request, env: Env) => Promise<boolean>;
  loadRun?: (
    env: Env,
    scope: { userId: string; sessionId?: string; runId: string },
  ) => Promise<Record<string, unknown> | null>;
  nowSeconds?: () => number;
}
```

Default `nowSeconds` is `Math.floor(Date.now() / 1000)`. Do not call `getAgentByName` unless `loadRun` is omitted. The default `loadRun` may import `getAgentByName` from `agents/routing` and `resolveRunStoreTarget` from `./runs-routes.js`, then `GET` the orchestrator path `/api/runs/<runId>`. If that import cycle hurts the test, keep default `loadRun` in the same file but tests always pass `loadRun`.

## File ownership

| Agent | Exclusive files |
| --- | --- |
| A | `packages/shared/src/swarm-desk.ts` |
| B | `packages/shared/src/swarm-share.ts` |
| C | `apps/backend/src/swarm-routes.ts` |
| D | `apps/backend/test/swarm-desk.test.ts` |
| E | `apps/backend/test/swarm-share.test.ts` |
| F | `apps/backend/test/swarm-routes.test.ts` |
| G | `apps/frontend/src/components/SwarmDeskView.tsx` |
| H | `apps/web/src/content/docs/docs/swarm-desk.md` |

Nobody else creates these. Nobody edits a file they do not own. Parent, after all eight status files exist, edits only:

- `packages/shared/src/index.ts` (two export lines)
- `apps/backend/src/index.ts` (import `handleSwarm`, call it next to `handleRuns`)
- `apps/frontend/src/components/AppNavRail.tsx` (one view id `swarm`, label `Swarm`, group Workspace)
- `apps/frontend/src/app.tsx` (one branch)
- `apps/web/astro.config.mjs` (sidebar item slug `docs/swarm-desk` under Operate, next to Tasks and Runs Dashboard)

## Imports

From `apps/backend/src/swarm-routes.ts`:

- `../../../packages/shared/src/swarm-desk.js`
- `../../../packages/shared/src/swarm-share.js`

From `apps/backend/test/*.test.ts`:

- `../../../packages/shared/src/swarm-desk.js` or `swarm-share.js`
- `../src/swarm-routes.js` for the route test

From `apps/frontend/src/components/SwarmDeskView.tsx`:

- `../../../../packages/shared/src/swarm-desk.js`

Use the `.js` specifier. Do not add a path alias.

## Required exports

`swarm-desk.ts`:

```ts
export const SWARM_LANES = ["backlog", "in_progress", "needs_review", "archived"] as const;
export type SwarmLane = (typeof SWARM_LANES)[number];
export const SWARM_MODES = ["captain", "build", "review"] as const;
export type SwarmMode = (typeof SWARM_MODES)[number];
export interface SwarmRunInput {
  runId: string;
  task: string;
  repoUrl: string;
  status: "pending" | "running" | "completed" | "error" | "aborted" | "cancelled" | "unknown";
  baseBranch: string;
  pullUrl?: string;
  screenshotUrl?: string | null;
  updatedAt: number;
  createdAt: number;
  summary?: string;
  role?: "orchestrator" | "explorer" | "fixer" | "reviewer" | "designer";
}
export interface SwarmCard {
  runId: string;
  title: string;
  task: string;
  repoUrl: string;
  status: SwarmRunInput["status"];
  lane: SwarmLane;
  mode: SwarmMode;
  baseBranch: string;
  pullUrl?: string;
  screenshotUrl?: string | null;
  updatedAt: number;
}
export function laneForRun(run: Pick<SwarmRunInput, "status" | "pullUrl">): SwarmLane;
export function modeForRole(role: SwarmRunInput["role"]): SwarmMode;
export function roleForMode(mode: SwarmMode): "orchestrator" | "fixer" | "reviewer";
export function projectSwarmDesk(runs: readonly SwarmRunInput[]): Record<SwarmLane, SwarmCard[]>;
export interface SwarmIntake {
  source: "linear" | "sentry" | "plain";
  title: string;
  prompt: string;
  externalId?: string;
  url?: string;
}
export function parseSwarmIntake(text: string): SwarmIntake;
export function normalizeSwarmWebhook(body: unknown): SwarmIntake | null;
```

`swarm-share.ts`:

```ts
export const SHARE_TTL_MIN_SECONDS = 60;
export const SHARE_TTL_MAX_SECONDS = 604800;
export interface ShareTokenClaims {
  runId: string;
  userId: string;
  sessionId?: string;
}
export interface ShareTokenPayload {
  exp: number;
  runId: string;
  sessionId: string | null;
  userId: string;
}
export function signShareToken(
  secret: string,
  claims: ShareTokenClaims,
  ttlSeconds: number,
  nowSeconds: number,
): Promise<string>;
export function verifyShareToken(
  secret: string,
  token: string,
  nowSeconds: number,
): Promise<ShareTokenPayload | null>;
export function redactShareView(
  run: Record<string, unknown>,
  lane: SwarmLane,
): Record<string, unknown>;
```

`SwarmDeskView` props:

```tsx
export interface SwarmDeskViewProps {
  runs: SwarmRunInput[];
  onApplyIntake: (prompt: string) => void;
  shareUrlFor: (runId: string) => Promise<string>;
}
export function SwarmDeskView(props: SwarmDeskViewProps): JSX.Element;
```

UI copy, no em dash, no new palette. Read `apps/frontend/src/components/DashboardView.tsx` and reuse its border, background, and type classes. Header `Swarm desk`. Subcopy `Backlog, in progress, needs review, archived. Threads queue here. Concurrent sandboxes stay capped by wrangler max_instances.` Lane labels `Backlog`, `In progress`, `Needs review`, `Archived`. Empty lane text `Nothing in this lane.` Textarea label `Linear link, Sentry link, or a plain task`. Button `Use as task`, disabled when the parsed prompt is empty. Each card shows title, mode chip (`Captain`, `Build`, or `Review`), repo, and a `Share` button. When `screenshotUrl` is a non-empty string, render `<img alt="Run preview">`. Do not say the preview is a video. Show share errors as text. No `alert`. Columns side by side from `1024px`, stacked below. `prefers-reduced-motion: reduce` disables transitions.

Docs frontmatter:

```md
---
title: Swarm desk
description: Four lanes over the runs you already have, plus share links and Linear or Sentry paste.
---
```

Say what is real (lanes, modes mapped onto orchestrator / fixer / reviewer, stateless share HMAC, paste intake) and what is not (snapshots, video, OAuth, raising `max_instances`).

## Tests that must pass

`swarm-desk.test.ts` covers: each status maps to the lane in the table; completed with and without `pullUrl` both land in `needs_review`; sort order; title truncation and empty title; `modeForRole` / `roleForMode`; linear URL, bare linear key, sentry URL, plain text, blank text; linear webhook, sentry webhook, `null` for `{}` and for `null`.

`swarm-share.test.ts` covers: the locked vector byte-for-byte; verify round trip; expired token (`nowSeconds === exp`) returns null; flipped signature byte returns null; empty secret throws on sign and returns null on verify; ttl 59 and 604801 throw; `redactShareView` drops `diff` and slices `summary` to 500.

`swarm-routes.test.ts` covers: unrelated path returns null; POST share without auth is 401; POST share with auth and no secret is 503; POST share with secret `test-secret`, now `1700000000`, runId `run_1` returns a url whose token verifies; GET with a bad token is 404; GET with a valid token and `loadRun` returning null is 404; GET with a valid token and a run that includes `diff` returns JSON without `diff`; POST intake of `ENG-1: Broken login` returns `source: "linear"`.

Route tests inject `isAuthorized`, `loadRun`, and `nowSeconds`. Do not boot a Worker.

## Done

When the owned files are written and the owned tests pass, write one line to `.build/status/agent<LETTER>.done` containing `ok`. Do not touch another agent's status file.
