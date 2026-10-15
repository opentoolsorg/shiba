---
title: ai-intern — Alchemy Integration & Plan Review
reviewer: devin/swe-2 via opencodex (model_reasoning_effort=max)
date: 2026-10-10
repo: /Users/princepal/Desktop/test/ai-intern
mode: read-only, no deploys, no network
status: critical findings independently re-verified by the orchestrating agent
---

> **How to read this.** Produced by an independent read-only review agent. The
> three Critical deploy defects (C1, C2, C3) and C4 were each re-verified by
> hand against the source tree after this report was written — see
> "Independent verification" at the end. Everything else is the reviewer's
> evidence, quoted with file:line.

---

# Alchemy Integration Review

## Verdict

The `alchemy.run.ts` stack is carefully written and mostly faithful to `wrangler.jsonc`, but the integration is not deploy-safe today: the live custom domain and cron triggers are not stage-gated, so every test-stage deploy dies at the domain attach (or worse, steals `app.tryshiba.dev` if ordering inverts); every alchemy deploy deletes all Worker secrets not present in the deploy environment — including `GITHUB_TOKEN`/`GITHUB_WEBHOOK_SECRET`, which the CI workflow explicitly assumes persist; and the `worker_loaders` `LOADER` binding is missing entirely, silently disabling the `codemode` MCP tool with no guard able to see it. The drift check is a genuinely good idea executed at ~80% coverage — it misses whole config surfaces (routes, workers.dev, worker_loaders, resource names, migrations). The auth design is stronger than it looks (JWT-verified identity rebuild), except in exactly the misconfigured live state the comments claim "fails closed."

## Findings — ranked by severity

### Critical

**C1 — `domain` and `crons` are not stage-gated; every test-stage deploy fails at the domain attach (verified defect).**

`alchemy.run.ts:167-168` declares `domain: { name: "app.tryshiba.dev" }` and `crons: ["*/5 * * * *"]` unconditionally. The stage-isolation design (lines 26-35, 79-93) suffixes only resource *names* — worker, container app, KV/R2/D1/Vectorize titles. The public route and triggers are identical on every stage.

Alchemy's domain reconciliation refuses to steal a hostname owned by another worker rather than re-routing traffic: `node_modules/alchemy/lib/Cloudflare/Workers/WorkerProvider.js` (`reconcileDomains`, ~line 1048-1058) — "Cannot attach hostname 'app.tryshiba.dev' to Worker '<stage>': it is already attached to Worker 'shiba-ai-coworker'…" via `Effect.die`. Consequences:

- `ALCHEMY_STAGE=test-* npx alchemy deploy` (the flow documented in `deployment.md` step "For an isolated test deployment, set ALCHEMY_STAGE…") fails mid-deploy once live owns the domain — which it does (`wrangler.jsonc:24-26` declares the custom domain).
- `pnpm test:ephemeral` (`package.json:32` → `scripts/ephemeral-stack.mjs --alchemy`) can never succeed in its current form.
- If a test deploy ever runs while live does *not* own the domain (post-`destroy`, fresh account), the test worker takes `app.tryshiba.dev`, and the *live* deploy then dies — the inverse poisoning. Compounding: `REQUIRE_ACCESS` is only bound on live stages (line 286), so a test stage holding the real hostname serves with no Access requirement at all.
- Every test stage also registers the `*/5 * * * *` cron, so test workers tick automations, the stale-draft sweep, and the audit prune every five minutes against their suffixed stores.

Fix: gate `domain` and `crons` on `isLiveStage` (`...(isLiveStage ? { domain: {…}, crons: […] } : {})`). Test stages then need a reachable URL — enable `workersDev` on non-live stages (it is currently `enabled: false` for all stages, line 163) or accept that ephemeral stacks are unreachable-by-design and drop the smoke step.

**C2 — Alchemy deploys delete every secret not present in the deploy environment; `deploy-worker.yml` relies on the opposite (verified defect in the workflow's assumption).**

`secrets()` binds only names present in `process.env` (`alchemy.run.ts:59-66`). The upload path is full-replace: `WorkerProvider.js` builds `metadataBindings` purely from declared resources + env (`appendAlchemyAndEnvBindings`, ~1895-1945) and sends `keepBindings: undefined` with no `keepSecrets` field (~3009-3030). Per the Cloudflare upload contract, omitting the keep list causes the new binding set to replace the previous one — which is exactly why wrangler explicitly sends `keepSecrets: true` ("we never delete secret bindings when uploading … inherit all unchanged secrets from the previous Worker Version", wrangler `wrangler-dist/cli.js`).

Net effect: **the `.env.example`/`.env.schema` claim "any secret missing here is REMOVED from the Worker on the next deploy" is TRUE for alchemy deploys** — but `deploy-worker.yml:38-39` asserts the inverse: "The worker's GITHUB_TOKEN/GITHUB_WEBHOOK_SECRET bindings aren't mappable here … stored values persist across deploys once set via wrangler." They do not. The first `deploy-worker.yml` run deletes `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `PAIRING_SECRET`, `BETTER_AUTH_SECRET`, `TELEGRAM_*`, `DISCORD_PUBLIC_KEY`, `CURSOR_SUBSCRIPTION_TOKEN`, and `DEVIN_SUBSCRIPTION_TOKEN` — none are in the workflow env block (lines 30-55) — silently killing GitHub webhook ingest, PR publishing, daemon pairing, better-auth, and the Telegram/Discord lanes until someone re-`secret put`s them, only to be wiped on the next deploy. Local `pnpm run deploy:alchemy` does the same for anything absent from `.env`.

Fix: either map the remaining secrets into the workflow env under GitHub-safe names (`SHIBA_GH_TOKEN` → `GITHUB_TOKEN`) — repo secrets can't literally start with `GITHUB_` but nothing stops remapping — or declare the CI workflow non-live and keep `wrangler deploy`/manual `alchemy deploy` for the live stage. Note the asymmetry worth documenting: wrangler keeps undeclared secrets (`keepSecrets: true`), alchemy deletes them — the same `.env` has opposite semantics under the two deploy paths.

**C3 — `worker_loaders` `LOADER` binding missing; `codemode` tool silently dead under alchemy deploys (verified defect).**

`wrangler.jsonc:108-110` declares `"worker_loaders": [{ "binding": "LOADER" }]`; `apps/backend/src/codemode.ts:76` — `if (!env.LOADER) return null` — so the `codemode` MCP tool (the single model-facing "write JS to chain tools" surface) silently disappears under `alchemy deploy` while working under `wrangler deploy`. `env.ts:17` types it optional (`LOADER?: WorkerLoader`), so nothing type-fails. Alchemy supports the binding: `lib/Cloudflare/Workers/WorkerLoader.d.ts` documents `Cloudflare.WorkerLoader` emitting a `worker_loader` binding (`WorkerAsyncBindings.js:612` — `type: "worker_loader"`).

Fix: add `LOADER: Cloudflare.WorkerLoader("LOADER")` to `env` in `alchemy.run.ts` (confirm exact prop name against `WorkerLoader` API), and add `["worker_loaders", "Worker Loader", (b) => b.binding]` to `BINDING_ARRAY_FIELDS` in `check-alchemy-drift.mjs:139-154` — the guard currently cannot see this binding class at all (see blind spots below).

**C4 — `REQUIRE_ACCESS` without `ACCESS_AUD` fails *open* to a forged identity header (verified defect, conditional on the warned-against misconfiguration).**

Live stages always bind `REQUIRE_ACCESS: "1"` (line 286) but `ACCESS_AUD` only when `accessEnabled` (line 294, gated on `ACCESS_EMAILS` + `WORKERS_SUBDOMAIN`). `withVerifiedAccessIdentity` (`access-jwt.ts:36`) returns the request untouched when `ACCESS_AUD` is unset, and `getUserId` (`request-auth.ts:27-33`) then trusts a client-sent `CF-Access-Authenticated-User-Email` header verbatim. `isAccessConfigured` (`request-auth.ts:23-25`) is true via `REQUIRE_ACCESS`, so `isAuthenticated` (`request-auth.ts:86`) passes on the forged header — one `curl -H 'CF-Access-Authenticated-User-Email: x@y.z'` reaches the dashboard/API. The warning block (lines 101-110) and README:98 claim this state "fails closed"; it fails open to forgery. `VERIFICATION.md`'s "forged Access identity headers get 401 (verified live)" was tested *with* `ACCESS_AUD` bound — the JWT path works; the unbound path does not.

Fix: strip `CF-Access-Authenticated-User-Email` at ingress whenever `ACCESS_AUD` is unset and `REQUIRE_ACCESS` is set (or unconditionally strip it on deployed hosts and let better-auth own the non-Access identity lane).

### High

**H1 — KV `AGENT_TOKENS` adoption-by-title probably binds a new empty namespace, orphaning all minted tokens (suspicion, one API call to confirm; code path verified).**

`wrangler.jsonc:139-140` pins `"id": "59cf73c3a6e0447fad8ced723d03fd13"` created per its own recipe `wrangler kv namespace create AGENT_TOKENS` → the live title is most likely `AGENT_TOKENS` (or wrangler's worker-prefixed form), not `shiba-agent-tokens`. Alchemy KV `read` falls back to `findNamespaceByTitle(title)` (`lib/Cloudflare/KV/Namespace.js` ~lines 156-161); on miss, `ensure` calls `createNamespace({ title: "shiba-agent-tokens" })` (~89-93) — which succeeds because the titles differ — and the Worker binds the fresh empty namespace. Every existing `shb_`/`sho_`/`shr_` token (agent-tokens.ts, oauth-mcp.ts mint into this store) silently dies on first alchemy deploy. D1 (`shiba-audit`), R2 (`shiba-attachments`), and Vectorize (`shiba-memory`) adopt by name and match.

Fix: `wrangler kv namespace list` to check the real title; if mismatched, rename the live namespace to `shiba-agent-tokens` once (Cloudflare KV titles are mutable, `updateNamespace`) before the first alchemy deploy, or change the alchemy title to the existing one.

**H2 — `ephemeral-stack.mjs` wrangler mode deploys the live route and live data stores (verified defect).**

The temp config only rewrites `name` and `preview_urls` (`scripts/ephemeral-stack.mjs:201-206`). `routes: [{ pattern: "app.tryshiba.dev", custom_domain: true }]` survives → `wrangler deploy` attempts to attach the live custom domain to the ephemeral worker (fails, or worse repoints it). `workers_dev: false` survives → the deploy emits no workers.dev URL → `pickWorkerUrl` returns null → smoke silently skipped. And `kv_namespaces`/`d1_databases`/`r2_buckets`/`vectorize` stay pinned to the live resource IDs — test traffic writes into production stores.

Fix: in wrangler mode also set `cfg.routes = []`, `cfg.workers_dev = true` (gives the smoke URL), and delete or suffix the store bindings; in alchemy mode this is moot until C1's domain gate exists.

**H3 — Local state backend + CI deploy = perpetual stateless adoption and orphaned resources (verified design gap).**

`Alchemy.localState()` is the default (lines 352-355); `deploy-worker.yml` does not set `ALCHEMY_STATE_BACKEND`. Every CI deploy starts with empty state: adoption re-runs by name (fine), but anything removed from code is never deleted — e.g., if `DashboardAccess`/`MachineBypass` are later dropped or renamed, the Cloudflare-side apps persist unmanaged forever, and no diff can see them. Two operators deploying "live" from different machines have divergent states. DO migration tags survive because they're recovered from worker script tags (`WorkerProvider.js` ~3129-3150), but state divergence is real for everything else.

Fix: set `ALCHEMY_STATE_BACKEND=cloudflare` in `deploy-worker.yml` after the one-time `npx alchemy provider cloudflare bootstrap`, and document that live deploys should run from one state home.

### Medium

**M1 — The Access apps front a disabled hostname; the real host has no edge Access at all (verified misconfiguration, partially intentional).**

`workerHost = ${workerName}.${workersSubdomain}.workers.dev` (line 99) while `workersDev: { enabled: false }` (line 163). `DashboardAccess` and `MachineBypass` destinations (`destinations: [{ uri: workerHost }]`, lines 131/140) therefore sit on a host that serves nothing; `app.tryshiba.dev` — the only public route — has no Access application. Human login on the real host is better-auth only; an `ACCESS_AUD` JWT is obtainable only via Access service tokens or by replaying a `CF_Authorization` cookie minted on the dead workers.dev host. The bypass list is written for a hostname real traffic never touches — defensible as a JWT-issuer + defense-in-depth, but it is not "Access in front of the dashboard" as README:86/95-99 describe.

**M2 — If edge Access ever fronts the real host, the bypass list is incomplete (verified gap vs `index.ts`/`request-auth.ts`).**

Worker-exempt but not in `ACCESS_BYPASS_PATHS`: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/oauth/register`, `/oauth/token`, `/oauth/revoke` (`isOAuthPath`, `request-auth.ts:56-64` — anonymous by protocol; MCP OAuth discovery and DCR die at the edge); `/api/auth/*` better-auth sign-in/session verbs (`request-auth.ts:80`); every `isPublicStaticPath` marketing path (`public-routes.ts:2-16` — `/`, `/docs/*`, `/_astro/*`, `/api/waitlist` POST is covered but GETs of the marketing pages are not); and bare `/api/local` (worker exempts it via `isLocalRuntimePath`, `local-routes.ts:26-27`; bypass has `/api/local/*` only). Correctly not bypassed: `/api/screenshots/:id` (self-gated, `screenshots-routes.ts:14-16`), `/api/whoami`, `/api/setup/status` (behind the main gate).

**M3 — `pnpm test:ephemeral` smoke is vacuous even where reachable (verified).**

`smoke()` counts any HTTP status including 401/404/5xx as success (`ephemeral-stack.mjs:225-242`); combined with no reachable URL on test stages (C1), the smoke proves nothing — a Cloudflare edge error page also returns a status.

**M4 — `REQUIRE_ACCESS` literal can be overridden by `.env` (verified footgun).**

`...(isLiveStage ? { REQUIRE_ACCESS: "1" } : {})` at line 286 precedes `...configVars([…"REQUIRE_ACCESS"…])` at line 295+, so a non-empty `REQUIRE_ACCESS` in `.env` wins over the live pin. Any non-empty string is truthy in `isAccessConfigured`, so impact is limited to inconsistency, but the ordering is backwards for a "fail closed" control.

### Low

- **`.env.example`/`.env.schema`/`README:101` secret-removal claim** is true for alchemy deploys but false for wrangler deploys (`keepSecrets: true`); worth one clarifying line since both paths are documented.
- **`PAIRING_SECRET`** is bound in `secrets()` (line 283) but absent from `.env.schema` and `.env.example`. **`USAGE_BUDGET_USD`** is in `.env.schema:130` and read at `usage.ts:59-60` but is in neither `vars` nor `configVars` — unbindable via either checked-in deploy path. **`SLACK_APPROVERS`/`SLACK_CHANNEL_REPOS`** are bound `secret_text` while `.env.schema:44-47` calls them "not a credential" (harmless but inconsistent classification).
- **Stage charset asymmetry**: `LIVE_STAGE = /^live(_|$)/` matches `live_x` but not `live-x`; a `test_foo` stage dies at module load (name regex, lines 91-93) while alchemy's own stage pattern allows underscores; `alchemy dev` dies on the stage assertion unless `ALCHEMY_STAGE` is set (defaults `dev_$USER`).
- **Docs staleness**: `deployment.md` tells users to open `https://shiba.<subdomain>.workers.dev/app/` — wrong worker name *and* `workers.dev` is disabled; `configuration.md` lists `ORCHESTRATOR_MODEL` as `@cf/meta/llama-3.1-8b-instruct` vs actual `@cf/zai-org/glm-4.7-flash` (`wrangler.jsonc:29`); `README:107` claims wrangler rollback deploys "the same bindings" — wrangler has `LOADER`, lacks `ACCESS_AUD`/`REQUIRE_ACCESS`, and has different secret semantics (C2). Pages project name is inconsistent three ways: README `shiba`/`shiba.pages.dev` vs `deploy.yml:36` `shiba-intern` vs `package.json:60` homepage.
- **`alchemy destroy` on a live stage destroys the adopted production resources** (D1 audit data, KV tokens, R2) — expected for destroy, but `pnpm deploy:destroy` is one unguarded command from production teardown.
- `pnpm build` is inside `deploy:alchemy` (good), but `npx alchemy deploy`/`ephemeral-stack` skip it — a stale or missing `public/` is deployable; a pre-deploy `existsSync("./public")` check is cheap insurance.

## Drift-guard blind spots (concrete counterexamples)

`scripts/check-alchemy-drift.mjs` verifies what's in its tables well — but whole classes of divergence pass green:

1. **`worker_loaders` uncollected** (`BINDING_ARRAY_FIELDS`/`BINDING_OBJECT_FIELDS`, lines 139-161): the missing `LOADER` binding exists in the repo today and is invisible to the guard — proven by C3. `check-env-types.mjs` has the same omission.
2. **`routes`/`domain` never compared**: delete `domain: { name: "app.tryshiba.dev" }` from `alchemy.run.ts` → green, and the worker deploys with no public route.
3. **`workersDev.enabled` unchecked**: only `previewsEnabled` is compared when `preview_urls === false` (lines 461-464). Flip `enabled` to `true` → green, `workers.dev` goes live against `workers_dev: false`.
4. **Binding `name`/properties unverified for non-container resources**: `AGENT_AUDIT: Cloudflare.D1.Database("AGENT_AUDIT", { name: "other-db" })` → green (presence check only, lines 474-479). Same for KV `title`, R2 `name`, Vectorize `index_name`/`dimensions`/`metric`, `ratelimits` limit/period/namespace_id, `send_email` `destination_addresses`.
5. **Kind unchecked for KV/R2/D1/Vectorize/RateLimit/SendEmail**: redeclare `AGENT_AUDIT` as a plain string or R2 bucket → presence still passes (kind is only asserted for DO, container, and AI).
6. **`migrations` excluded** (comment lines 136-138): remove the `deleted_classes: ["McpGateway"]` entry or reorder `new_sqlite_classes` → green; alchemy auto-emits only what it sees in *its* state, so the wrangler history and alchemy's derived migrations can diverge silently.
7. **Regex-anchored const checks are spoofable**: `const\s+workerName[\s\S]*?"shiba-ai-coworker"` (lines 424-425) matches `Alchemy.Stack("shiba-ai-coworker")` at line 349 — rename the pinned worker name to anything and keep the stack name → green. Same pattern for `containerName` (line 536) if the literal appears anywhere later.
8. **Spread members are invisible**: `...secrets([...])`, `...configVars([...])`, `...(isLiveStage ? …)`, `...(DashboardAccess ? { ACCESS_AUD } : {})` are skipped entirely (lines 244-263). Moving `ROLE_MODEL_MAP` into `configVars` correctly *fails loud* (the comment at lines 287-289 documents this), but nothing validates the *names inside* the spread lists — a typo'd secret name binds nothing and reports nothing.
9. **Section (e) can't see new anonymous surfaces**: it reverse-checks only `SIGNATURE_AUTHENTICATED` plus four hardcoded heuristics (`isMcpPath`, `isLocalRuntimePath`, `parseAutomationWebhookPath`, `isPublicRequest` for `/api/waitlist`, lines 585-603). `isOAuthPath`, `isBetterAuthPath`, and the rest of `isPublicRequest` are unenumerated — exactly the M2 gaps, and future ones land silently.
10. **Parser edge cases (style/robustness)**: `literal()` corrupts single-quoted strings containing `\'` (line 316); `membersToMap` last-wins on duplicate keys; a backtick inside `${}` in a template literal breaks brace tracking. Each is unlikely to *hide* real drift — parse failures die loud — but (1) and (5) can.

## Unused Alchemy capabilities worth adopting

- **`alchemy drift`** — compares live state to desired; complements this static file-parity guard with real deployed-drift detection (dashboard-deleted secrets, stale bindings, removed Access apps — directly relevant to H3).
- **`alchemy state`** — required hygiene once state is shared (H3); also the only sane way to inspect what's tracked before `deploy:destroy`.
- **`alchemy dev`** — would unify the local story (currently `wrangler dev` + `.dev.vars`); note it dies at the stage assertion unless `ALCHEMY_STAGE` is set (`dev_$USER` default fails `LIVE_STAGE`).
- **`alchemy logs`** — tail the deployed worker without wrangler.
- **`version`/traffic + `previewAlias`** — gradual rollouts and version previews are the natural per-PR story; today there is **no per-PR preview deploy wired anywhere** (`ci.yml` runs drift+tests only, `deploy-worker.yml` is `workflow_dispatch` only, `deploy:preview` is `alchemy plan` locally).
- **`Cloudflare.state()`** — the opt-in exists; CI doesn't use it (H3).

`alchemy plan` *is* used (`deploy:preview`), and the Worker-level `access` prop is correctly avoided (WebSocket 403s — well-reasoned at lines 95-96).

---

# Plan Review

## Verdict

PLAN.md is unusually honest — its status table matches the tree far better than most living documents, and its central open item (T10, a dated live cloud run) is reported accurately, including the honest "not proven" caveats around §20. Its rot is cosmetic-but-real: a task-number collision (T52), stale status banners, a few claims that predate landing code, and stale doc references. The substantive risk is that the plan's own deploy assumptions are now wrong in two places it doesn't know about (C1/C2 above) — which directly block the T10/T37 acceptance it correctly identifies as the only remaining gate.

## Contradictions and stale claims (with file:line)

- **T52 collision**: `PLAN.md:1299` "T52 daemon heartbeat + fleet registry" vs `PLAN.md:93` "T52 role routing — ROLE_MODEL_MAP…" and `PLAN.md:1330` "The role seam shipped in T52 (`agents/roles.ts`)". Two different deliverables share one id; later T-numbers after T51 in §19 (T52–T55) conflict with §2.1's P9 usage.
- **Effort total stale**: `PLAN.md:21` "~55h" covers P0–P6 only; the plan now runs to P11. Status banners are also rev-stale by design: TL;DR carries "Rev 4 status"/"Rev 9 status" rows (lines 23-24) in a rev-12 document, and `### 2.0` is reused three times (lines 56, 112, 132 for revs 11/8/7).
- **`"no AGENTS.md exists in this repo"`** (`PLAN.md:58`, rev-11 note): `AGENTS.md` exists at root today (1016 bytes).
- **§17.5 T33 "Screenshot is the genuinely missing half"** (`PLAN.md:897-901`): `screenshot.ts` + `captureRunPreview` shipped (`agents/opencode-agent.ts:334,421`, `screenshots-routes.ts`), and §2.0's own rev-11 note says the screenshot half merged (PRs #22/#23) — §17.5 was never updated.
- **References: `spec/GOAL.md (stale as of rev 2 — T17)`** (`PLAN.md` References block): GOAL.md was amended (items 12-15 cover Slack/automations/desktop; "This supersedes the earlier no-monorepo line").
- **§20.2 "pin `openai/gpt-5.6-sol`" vs the shipped pin**: the body records the correction and the 2026-10-09 swap to `gpt-6-sol` — internally consistent, but the earlier sentence is easy to misread; the actual pinned id is `openai/gpt-6-sol` (`wrangler.jsonc:52`, `alchemy.run.ts:292-293`).
- **`deployment.md` URL** `https://shiba.<sub>.workers.dev/app/` — wrong worker name and `workers.dev` is disabled.
- **`configuration.md` `ORCHESTRATOR_MODEL` row** claims `@cf/meta/llama-3.1-8b-instruct`; shipped default is `@cf/zai-org/glm-4.7-flash`.
- **Deploy-path description**: PLAN §18.14's "alchemy primary, wrangler rollback, `check-alchemy-drift` must stay green" matches intent; but the plan predates the secrets wipe (C2), the domain stage-gate (C1), and the LOADER binding gap (C3) — its deploy story is currently more correct than the code.

## Spot-check of "Done" tasks

| Task | Claim | Verified? | Evidence |
|---|---|---|---|
| T56 | `ROLE_MODEL_MAP` pinned in vars | ✅ | `wrangler.jsonc:52`; `alchemy.run.ts:292-293` literal member; `agents/roles.ts` |
| T57 | role routing proven e2e | ✅ | `apps/backend/test/roles.test.ts` + `roles-e2e.test.ts` exist (113 test files) |
| T58 | CLI pins aligned | ✅ | `Dockerfile:20` — `@anthropic-ai/claude-code@2.1.284`, `@openai/codex@0.157.1` match claims |
| T48–T50 | subscription harnesses landed | ✅ files; live-probe caveat honestly recorded | `harness/{claude,codex,antigravity}-subscription.ts`; `packages/auth`; `packages/shared/src/{codex-home,antigravity,auth}.ts` |
| T51 | local runtime adapter | ✅ | `local-routes.ts`, `local-dispatch.ts` (`LocalDispatch` DO, migration v9), `scripts/shiba-local-daemon.mjs`, `/api/local/*` routes |
| T52–T55 | fleet registry + pairing + view + docs | ✅ | `local-fleet.ts`, `local-fleet-schema.ts`, `computers-routes.ts`, `local-fleet.test.ts`, `remote-access.md`, `RemoteAccessView` wired |
| T40–T47 | decider/receipts/signals/checkpoints/auth core | ✅ | `packages/shared/src/{decide,command-receipts,run-signals,events,projector,auth}.ts`, `git-checkpoint.ts`, `exec-allowlist.ts`, `packages/auth` |
| T27 | GOAL.md reconciled | ✅ | `spec/GOAL.md` now blesses the monorepo + Slack + automations + desktop |
| T29 | OAuth MCP | ✅ files | `oauth-mcp.ts` full AS; `/oauth/*` + `/.well-known/*` routes in `index.ts` |
| T25 | deploy button + prerequisites | ⚠️ overstated | No `deploy.workers.cloudflare.com` badge anywhere in `README.md` (only Site/Docs/License badges, lines 3-5). Either add it or correct the row |
| T28 | audit clean | ⚠️ partially verifiable | `VERIFICATION_PLAN.md` + `audit/` screenshots exist; "clean" is a dated claim I can't independently re-run read-only |
| T10 | live acceptance run | ✅ honestly reported **open** | `PLAN.md:147`, `VERIFICATION.md` — blocked on cloud deploy + AI Gateway credential; not claimed done |

## B1–B12 current reality

| # | Claim | Reality now |
|---|---|---|
| B1 | `new_classes` not `new_sqlite_classes` | **Fixed** — `new_sqlite_classes` v1–v9 + `deleted_classes` v8 (`wrangler.jsonc:177-187`) |
| B2 | no `instance_type` → `lite` | **Fixed** — `instance_type: "standard-1"` + `INSTANCE_TYPE` var, triple-checked by the drift guard (lines 544-552 — the coupling is *enforced*, not comment-only) |
| B3 | dead `CODING_MODEL` | **Fixed** — `google/gemini-3.5-flash-lite` + `assertLiveCodingModel` startup check (`index.ts:204`) + `RETIRED_MODELS` (`roles.ts:141`) |
| B4 | `WORKER_ORIGIN` throw | **Fixed** — zero references remain; `provider-gateway.ts` persists only as a utils module (`DUMMY_PROVIDER_KEY`, header sanitizers — imported by tests; `provider-exports.test.ts` asserts `forwardProviderRequest` is gone) |
| B5 | open egress | **Fixed** — `override allowedHosts` (`sandbox.ts:38`) + per-run narrowing via `allowedHostsFor` |
| B6 | token to all of github.com | **Fixed** — `approveRepoScope` per-repo forwarder; cross-repo refusal tested per `VERIFICATION.md` |
| B7 | unauthenticated API/WS | **Fixed** — `isAuthorizedRequest` gate + verified-JWT identity rebuild + better-auth; **residual**: REQUIRE_ACCESS-without-ACCESS_AUD is forgeable (finding C4) |
| B8 | any output ⇒ `completed` | **Fixed** — `verifyRunOutcome` + `harness.verify` gate + `testEvidence` (T43/T46) |
| B9 | `sleepAfter="10m"`, never destroyed | **Mostly fixed** — `sleepAfter = "1m"` (`sandbox.ts:25`); `destroyManagedContainer` + `leakedContainers` retry path (`agents/orchestrator.ts` ~2326-2378). Idle tail now ~1m, not 10m |
| B10 | concurrency 3 | **Fixed** — `MAX_CONCURRENT_RUNS = 5` (`packages/shared/src/runs.ts:181`), `max_instances: 5` both files |
| B11 | provider lock-in | **Fixed** — harness seam + `allowedHostsFor(harness, model)`; 10+ adapters in `harness/` |
| B12 | OpenCode hardcoded | **Fixed** — `harness/` registry incl. subscription and ACP lanes |

§8's cost model is dated 2026-09-17 and self-flagged ("rates change"); the "Gemini 3.8 Flash doubles 2027-01-01" figure should be re-verified before reuse, and the shipped default is `gemini-3.5-flash-lite` (different model than the pricing example) — directionally right (tokens ≫ compute), numerically stale. §3's star counts and the "70,000+ engineers" Capy claim are competitor marketing figures explicitly labeled "claimed/observed"; treat as stale-by-nature, not wrong.

## Highest-value next task (one, with justification)

**T10/T37 — the dated live acceptance run — is still the only task that matters, and the two deploy defects found here are now its real blockers.** Everything else on the critical path is built and unit-verified; nothing is proven end to end. Specifically: run a real `alchemy deploy` to a live stage after (a) fixing C1 so the deploy can complete without the domain collision and (b) fixing C2 so `GITHUB_TOKEN`/`GITHUB_WEBHOOK_SECRET` aren't wiped by the deploy that performs the test — then execute the §15 P2 bar and T37–T39 on a throwaway repo. Without this, the repo's honest "local prototype" label stays correct no matter how much lands.

# Open questions

1. **Actual KV title of `59cf73c3…`** — one `wrangler kv namespace list` determines whether H1's orphaning is real. If the title is already `shiba-agent-tokens`, downgrade H1 to noise.
2. **Does Cloudflare strip inbound `CF-Access-Authenticated-User-Email` on hostnames with no Access app?** If it does, C4's forge hole is theoretical; the `access-jwt.ts` rebuild design suggests the authors believe it does not (and public Cloudflare guidance agrees), but a one-line curl against the live worker settles it.
3. **First-deploy adoption behavior on the real account** — whether `AdoptPolicy.adopt(true)` cleanly takes over the wrangler-managed worker, container app, D1, R2, and Vectorize in one pass, or hits partial-adoption states that need `--adopt` retries. Only a real deploy proves it.
4. **`alchemy destroy` scope on live** — whether adopted wrangler resources are all tracked for deletion (expected: yes, including data); worth a dry read of `alchemy plan` output before ever running `deploy:destroy`.
5. **Whether the Access service-token flow is the intended `ACCESS_AUD` consumer** — if so, it needs a doc: mint JWT on the workers.dev Access app, replay it to `app.tryshiba.dev`. Nobody will discover that dance unaided.
6. **`alchemy dev` viability for the container-backed worker** — whether alchemy's local emulation handles the Sandbox DO + container + `worker_loaders` triple; if it does, it could retire the `wrangler dev` + `.dev.vars` split.

---

# Independent verification (added by orchestrator)

Re-checked after the review completed, against the live tree:

| Finding | Check run | Result |
|---|---|---|
| C1 | `sed -n '160,170p' alchemy.run.ts` | Confirmed — `domain`/`crons` unconditional at lines 167-168; not gated on `isLiveStage` |
| C1 | `grep -n "already attached" node_modules/alchemy/lib/Cloudflare/Workers/WorkerProvider.js` | Confirmed — `Effect.die(...)` at line 1054 |
| C2 | `grep -c keepSecrets node_modules/wrangler/wrangler-dist/cli.js` | 8 — wrangler does keep undeclared secrets |
| C2 | `WorkerProvider.js:3009-3030` | Confirmed — `keepBindings: undefined`, no keep-secrets field |
| C3 | `grep -c "LOADER\|WorkerLoader" alchemy.run.ts` | **0** — binding absent |
| C3 | `grep -n worker_loaders apps/backend/wrangler.jsonc` | Present at lines 108-110 |
| C3 | `sed -n '70,80p' apps/backend/src/codemode.ts` | Confirmed — `if (!env.LOADER) return null` at line 76 |
| C3 | `grep -n worker_loaders scripts/check-alchemy-drift.mjs` | **No match** — guard blind spot confirmed |
| C3 | `ls node_modules/alchemy/lib/Cloudflare/Workers/` | `WorkerLoader.js` exists — alchemy supports the binding |
| C4 | `sed -n '25,50p' apps/backend/src/access-jwt.ts` | Confirmed — `if (!env.ACCESS_AUD) return request;` returns untouched |
| H1 | `grep -n AGENT_TOKENS -A3 alchemy.run.ts` | Confirmed — title `shiba-agent-tokens${resSuffix}` vs wrangler id `59cf73c3...` |

Two corrections to earlier working notes made during this review:

- The OAuth/`/.well-known/*` bypass gap is **latent, not live-breaking** (M1 shows
  the Access apps front a host that serves nothing), so it is Medium, not
  Critical.
- `MAX_CONCURRENT_RUNS = 5` at `packages/shared/src/runs.ts:181` — B10 is fully
  fixed, resolving an item the orchestrator had left open.

**Highest-value next task:** T10/T37 live acceptance run, now blocked on code
(fix C1 so a deploy completes, C2 so the deploy does not wipe the secrets the
test needs, C3 or `codemode` is untestable) rather than on credentials.
