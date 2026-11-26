# Authorization & route inventory (M08 prep)

Snapshot of how `apps/backend/src/index.ts` `fetch()` (~764 lines, ~95 dispatch
sites over ~65 handler modules) authenticates every route **today**, grouped by
the lanes M09 will convert (`docs/proposals/target-architecture-2026-11.md`
§18 M08/M09, §14 "Security and routing").

Companion artifact: `apps/backend/test/routes-auth-snapshot.test.ts` records the
effective **unauthenticated** status of 259 request shapes under an
Access-configured env (`REQUIRE_ACCESS=1`, `ACCESS_AUD` set, webhook secrets
set, `BETTER_AUTH_SECRET` unset). M08's route table must keep every recorded
status identical; M09 then assigns each group an explicit `AuthMode`.

## 1. The pipeline, in order

`index.ts` `fetch()` is a sequential chain, not a table. Auth is enforced at
four distinct layers:

| # | Layer | Where | Mechanism |
|---|-------|-------|-----------|
| 0 | Access-JWT identity rebuild | `access-jwt.ts` `withVerifiedAccessIdentity` | Rebuilds `CF-Access-Authenticated-User-Email` only from a verified Access JWT; strips client-sent copies when `ACCESS_AUD`/`REQUIRE_ACCESS` set. |
| 1 | Pre-gate handlers | `index.ts:293–349` | Founder permit, artifact download, better-auth, Slack install callback, dev OAuth loopback, marketing/static shells, `handleShare` — all run **before** the identity gate and carry their own auth. |
| 2 | Identity gate | `index.ts:351` | `!isPublicRequest && !isOrgApiPath && !isAuthorizedRequest` → 401 JSON (or 302 to `/?next=` for `GET /oauth/authorize` with `Accept: text/html`). |
| 3 | Post-gate handlers | `index.ts:375–757` | ~90 `handle*()` calls in fixed order; each re-checks path internally and returns `null` on miss. Webhook lanes self-authenticate by signature/secret; `/api/*` session routes rely on the gate plus route-local owner/workspace checks. |
| 4 | Fallbacks | `index.ts:676–757` | `/agents/coding-orchestrator/*` DO route, `routeAgentRequest`, `/internal/*` → 404, unmatched `/api/*` → JSON 404, everything else → `env.ASSETS`. |

### Exemption lists the gate consults (`request-auth.ts`, `public-routes.ts`)

- `SIGNATURE_AUTHENTICATED` — 9 exact paths exempt for **any** method
  (non-POST is later 405'd at `index.ts:420`): `/api/slack/events`,
  `/api/slack/command`, `/api/slack/interact`, `/api/telegram/webhook`,
  `/api/discord/interactions`, `/api/github/webhook`, `/api/linear/webhook`,
  `/api/sentry/webhook`, `/api/trigger`.
- `isAutomationWebhookPath` — `/api/automations/{id}/trigger` (any method).
- `isMcpPath` — `/mcp`, `/mcp/*`.
- `isOAuthPath` — `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/oauth/register`, `/oauth/token`,
  `/oauth/revoke` (note: **not** `/oauth/authorize` — that one is gated).
- `isLocalRuntimePath` — `/api/local`, `/api/local/*`.
- `OPEN_DASHBOARD=1` + GET/HEAD + `/`, `/app`, `/app/*`, `/assets/*`.
- `isBetterAuthPath` (`/api/auth/*` minus the four `*-subscription` lanes) —
  only when `BETTER_AUTH_SECRET` is configured.
- No auth configured at all → loopback hosts only.
- `isPublicRequest` — GET/HEAD public static paths, GET `/api/v1/openapi.json`,
  GET `/api/integrations/provider/callback`, GET/HEAD `/api/health`,
  POST `/api/waitlist`, POST `/api/sentry/webhook`, GET `/share/[cf]/{token}`,
  GET `/api/share/file/{token}`.
- `isOrgApiPath` — 10 prefixes that skip the Access gate and self-authenticate
  inside their handlers (see §4).

## 2. M09 lane (a) — webhooks

All signature/secret-authenticated; all bypass the Access gate by design.
Effective unauthenticated status today: **401** when the corresponding secret
is configured, **503 "Webhook is disabled"** when it is not (except where
noted).

| Path(s) | Handler (file) | Auth mechanism | Notes / exemptions |
|---|---|---|---|
| `POST /api/slack/events` | `slack-events.ts` `handleSlackEvents` | Slack signing-secret HMAC (`verifySlackRequest`) | Two layers: `handleMultiInstallationSlackCallback` (`slack-installations-routing.ts`) intercepts first and verifies the same signature when `SLACK_INSTALLATIONS_ENABLED`/history applies; falls through to legacy handler otherwise. GET → 405. |
| `POST /api/slack/command` | `slack-routes.ts` `handleSlackCommand` | Slack signing-secret HMAC | Same dual-layer as events. GET → 405. |
| `POST /api/slack/interact` | `slack-approval.ts` `handleSlackInteract` | Slack signing-secret HMAC, then `SLACK_APPROVERS` allowlist | Approver check happens **after** signature; bad signature → 401. GET → 405. |
| `GET /api/slack/installations/callback` | `slack-installations-routes.ts` `handleSlackInstallations` | OAuth `state` → pending-installation → native workspace owner (`resolveOrgForApiRequest` + `resolveWorkspaceNativeMember`) | **Pre-gate** (`index.ts:321`). Not session-gated by design; 503 `slack_installation_operator_setup_required` when OAuth env unset. Sibling paths `/api/slack/installations*`, `/begin`, `/{id}/(activate|revoke|refresh)` are post-gate + owner-only. |
| `POST /api/github/webhook` | `github-webhook-routes.ts` `handleGitHubWebhook` | `GITHUB_WEBHOOK_SECRET` HMAC-SHA256 (`x-hub-signature-256`) | Secret unset → 503. Valid sig then requires `X-GitHub-Delivery` + DO dedupe. GET → 405. |
| `POST /api/linear/webhook` | `linear/routes.ts` `handleLinearWebhook` | `LINEAR_WEBHOOK_SECRET` signature (`linear-signature` header) | Secret unset → 503 unless `LINEAR_ALLOW_UNSIGNED_WEBHOOK=1` (dev escape hatch — see Findings). GET → 405. |
| `POST /api/discord/interactions` | `discord.ts` `handleDiscordInteractions` | `DISCORD_PUBLIC_KEY` ed25519 signature over raw body | Unset → 503. GET → falls through (405 only via SIGNATURE_AUTHENTICATED check — actually GET → 405). |
| `POST /api/telegram/webhook` | `telegram.ts` `handleTelegramWebhook` | `TELEGRAM_WEBHOOK_SECRET` via `X-Telegram-Bot-Api-Secret-Token` header + `TELEGRAM_BOT_TOKEN` | Both required; missing either → 503. |
| `POST /api/sentry/webhook` | `sentry-webhook-routes.ts` `handleSentryWebhook` | `SENTRY_WEBHOOK_SECRET` — `sentry-hook-signature` HMAC or `x-sentry-token`/Bearer constant-time compare | **Doubly exempt**: `SIGNATURE_AUTHENTICATED` *and* `isPublicRequest` POST. Handler still verifies before queueing. Unset → 503. GET → 405. |
| `POST /api/trigger` | `trigger.ts` `handleTrigger` | `TRIGGER_TOKEN` bearer, min 32 chars | `<32` chars → 503 (fail closed). Per-IP rate limit first. |
| `POST /api/automations/{id}/trigger` | `automations-routes.ts` → `automations-do.ts` | Per-automation `webhookSecret`, constant-time compare inside the DO | Exempt via `isAutomationWebhookPath` for **any method**: GET → DO 404; POST bad/missing secret → DO 401. Sibling `/api/automations`, `/{id}`, `/{id}/run` are **not** exempt → Access gate. |

Related but **not** webhook-signature lanes:
- `handleSlackCoworker` (`slack-coworker-routes.ts`, `/api/slack/coworker*`) —
  dashboard surface behind the Access gate + team-member policy; `verify()`
  resolves workspace membership inside.
- `handleSlackImport` (`slack-import/routes.ts`, `/api/slack-import*`) —
  Access gate + member checks.
- `handleIntegrationsRoutes` (`integrations-routes.ts`,
  `/api/integrations/slack/verify`, `/github/status`, `/linear/status`) —
  Access gate + session.

## 3. M09 lane (b) — `/mcp`, `/api/local`, MCP OAuth

| Path(s) | Handler (file) | Auth mechanism | Notes |
|---|---|---|---|
| `/mcp`, `/mcp/*` (any method) | `mcp-routes.ts` `handleMcp` | `bearer:mcp` — `shb_` agent token or `sho_` OAuth access token via `verifyToken`/`verifyOAuthAccessToken`; 401 + `WWW-Authenticate` resource-metadata on failure | Pre-auth `MCP_RATE_LIMIT` KV check. `MCP_PRINCIPAL_HEADER` stripped at ingress and re-set only post-verify. No method check — GET `/mcp` also 401s unauthenticated. |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` | `oauth-mcp.ts` `handleDiscovery` | **public** (RFC 8414/9728) | 200 JSON, no auth. |
| `POST /oauth/register` | `oauth-mcp.ts` `handleRegister` | **public** (RFC 7591 dynamic client registration, public clients only) | Rate-limited per IP via `AGENT_TOKENS` KV. Valid `redirect_uris` (https or loopback http) → 201 + `client_id`; bad metadata → 400. |
| `GET/POST /oauth/authorize` | `oauth-mcp.ts` `handleAuthorize` | **session** — Access/better-auth identity (`ownerId` resolved in index.ts), or `admin:tokens` bearer fallback | **Not** in `isOAuthPath` → hits the identity gate first: bare GET → 401 JSON, or 302 → `/?next=` when `Accept: text/html`. Inside, owner consent mints single-use PKCE code. |
| `POST /oauth/token` | `oauth-mcp.ts` `handleToken` | **public** (authorization_code + refresh_token grants) | Code is single-use KV record; PKCE S256 enforced; refresh rotation with replay detection. Bad grant → 400. |
| `POST /oauth/revoke` | `oauth-mcp.ts` `handleRevoke` | **public** (RFC 7009) | Always 200; never reveals token existence. |
| `/api/local`, `/api/local/*` | `local-routes.ts` `handleLocalAdapter` | `bearer:local` — deployment `LOCAL_ADAPTER_TOKEN` or per-machine adapter token (hash-checked via DO); `/pair` uses HMAC pairing token instead | **404 when `SHIBA_LOCAL_RUNTIME !== "1"` or `LocalDispatch` unbound** — fail closed. Personal-machine tokens restricted to `DAEMON_VERBS`. |
| `GET/POST /api/dev/oauth-loopback` | `dev-oauth-loopback-routes.ts` | Loopback host (`127.0.0.1`/`localhost`) + `SHIBA_DEV_OAUTH_LOOPBACK_SECRET` (POST) or session (GET) | Dev-only; **404 on non-loopback hosts** and when secret unset. |

## 4. M09 lane (c) — `/api/*` session routes

Everything below is behind the index.ts identity gate (Access JWT→email, or
better-auth session, or loopback when no auth system is configured) **unless**
listed under `isOrgApiPath`/`isPublicRequest` exemptions. Route-local checks
(owner resolution, workspace membership, CSRF/origin) layer on top.

### 4a. `isOrgApiPath` — gate-exempt, self-authenticating

These skip the Access gate; each handler calls `resolveOrgForApiRequest`
(dashboard session **or** `shk_`/`sho_` org API key via `authorizeV1Request`)
or `authorizeV1Request` directly. Unauthenticated → **401**
(`{"_tag":"shiba/Unauthorized"}` or handler JSON).

| Prefix(es) | Handler (file) | Self-auth |
|---|---|---|
| `/api/api-keys` | `api-keys-routes.ts` | `authorizeV1Request` (`api:keys:admin`) or dashboard session |
| `/api/v1/extensions/skills*` | `v1/extension-skills.ts` via `v1-routes.ts` | `resolveOrgForApiRequest` |
| `/api/skills/library*` | `skill-library-routes.ts` | `resolveOrgForApiRequest` |
| `/api/spaces*` | `spaces-routes.ts` | `resolveOrgForApiRequest` |
| `/api/employee-tools*` | `employee-tool-routes.ts` | `resolveOrgForApiRequest` |
| `/api/reason-network*` | `reason-network/routes.ts` | `isAuthorizedRequest` + `resolveUserId` |
| `/api/custom-agents*` | `custom-agents-routes.ts` | `resolveOrgForApiRequest` |
| `/api/org/sandbox`, `/api/org/sandbox/test` | `org-sandbox-routes.ts` | `resolveOrgForApiRequest` |
| `/api/org/model-keys*` | `org-model-keys-routes.ts` | `resolveOrgForApiRequest` |
| `/api/v1/runs` | `api-keys-routes.ts` (v1Runs lane) | `authorizeV1Request`; non-apiKey principals fall through to `handleV1` |

### 4b. Public (`isPublicRequest`) API endpoints

| Path | Handler | Auth |
|---|---|---|
| `GET/HEAD /api/health` | `meta-routes.ts` | none — `{ok:true}` |
| `GET /api/v1/openapi.json` | `v1-routes.ts`/`v1/openapi.ts` | none — public spec |
| `GET /api/integrations/provider/callback` | `integrations-provider-routes.ts` | none — static OAuth-return HTML page |
| `POST /api/waitlist` | `waitlist.ts` | none — Origin allowlist (worker origin or Pages origin) + JSON + DO; `/api/admin/waitlist` stays gated |
| `POST /api/sentry/webhook` | (see §2) | exempt here *and* signature-verified inside |
| `GET /share/[cf]/{token}`, `GET /api/share/file/{token}` | `share-routes.ts` | none — share-link token is the credential; unknown token → 404 |

### 4c. Session-gated `/api/*` handlers (post-gate, index.ts order)

All return **401** unauthenticated at the gate; listed with their route-local
authz on top. Dynamic-import handlers marked †.

| Handler (file) | Paths | Route-local authz |
|---|---|---|
| `enforceTeamMemberApiPolicy` (`team-member-auth.ts`) | policy gate, not a route | Denies restricted better-auth "invited" members per-path allowlists; no-op for unauthenticated |
| `handleRunOutputArchives` (`run-output-archive-routes.ts`) | `/api/run-output-archives*` | better-auth **bootstrap** session only; 403 otherwise; rejects `authorization`/`X-Shiba-Workspace` headers |
| `handleSlackInstallations` (`slack-installations-routes.ts`) | `/api/slack/installations*` (non-callback) | native workspace **owner** via `resolveOrgForApiRequest` + membership; CSRF/origin checks |
| `handleSlackCoworker`† (`slack-coworker-routes.ts`) | `/api/slack/coworker*` | member `verify()` + workspace binding |
| `handleSharedComputers` (`shared-computer-routes.ts`) | `/api/shared-computers*` | member auth; session-scoped operations |
| `handleWorkspaceIntegrations` (`workspace-integrations-routes.ts`) | `/api/workspace-integrations*` | member auth |
| `handlePersonalExecution` (`personal-execution-routes.ts`) | `/api/personal-execution*` | native owner for stop/unpair; member otherwise; flag-gated 404 |
| `handleTeamModelSessions`† (`team-model-routes.ts`) | `/api/team-model-sessions*` | workspace member |
| `handleTeamWork` (`team-work-routes.ts`) | `/api/workspaces/{id}/work*`, `/api/needs-you` | workspace member |
| `handlePrimaryBot` (`collaboration-primary-bot-routes.ts`) | `/api/workspaces/{id}/primary-bot` | workspace member |
| `handleSearch`† (`search-routes.ts`) | `/api/search` | session |
| `handlePalette`† (`palette-routes.ts`) | `/api/palette/*` | session |
| `handleAskUser`† (`ask-user-routes.ts`) | `/api/runs/{id}/ask-user/*` | session + run ownership |
| `handleTeamWorkspaces` (`team-workspaces-routes.ts`) | `/api/workspaces*` | session + membership |
| `handleGovernance` (`governance-routes.ts`) | `/api/governance*` | session; `/admin/*` needs deployment operator |
| `handleShare` 2nd pass (`share-routes.ts`) | `POST /api/share` | session (`isAuthorizedRequest` + verified email) — **note: first pass at index.ts:349 already answers POST /api/share with 401 pre-gate** |
| `handleEmailDeliveryRoutes` (`email/routes.ts`) | `/api/email/delivery-status` | session + `isTeamDeploymentOperator` |
| `handleFirstRunSeed`† (`first-run-seed.ts`) | `/api/first-run-seed` | session |
| `handleEmployeeBundles` (`employee-bundles-routes.ts`) | `/api/employee-bundles/{export,preview,import}` | session/member |
| `handleGmail` (`gmail-routes.ts`) | `/api/connections/gmail*` | session + owner |
| `handleOAuth` (`oauth-mcp.ts`) | `/oauth/authorize` | `ownerId` pre-resolved by index.ts (`resolveUserId`) |
| `handleWaitlist` (`waitlist.ts`) | `/api/waitlist`, `/api/admin/waitlist` | POST public (§4b); admin GET/DELETE gated |
| `handleMeta` (`meta-routes.ts`) | `/api/health`, `/api/whoami`, `/api/setup/*`, `/api/agents`, `/api/model-config*`, `/api/email/openapi.json` | session (except `/api/health`); `/api/model-config/*` mutations add same-origin CSRF |
| `handleWorkspaceEvents`† (`platform/workspace-events-routes.ts`) | `/api/workspaces/{id}/events` | workspace member |
| `handleTeamOnboardingTask`† (`team-onboarding-task.ts`) | `/api/onboarding/progress/team-task` | session |
| `handleOnboardingProgress` (`onboarding-progress.ts`) | `/api/onboarding/progress` | session |
| `handleAcpProviders` (`acp-provider-routes.ts`) | `/api/providers*` | session; team members restricted by policy |
| `handleApiKeys` (`api-keys-routes.ts`) | `/api/api-keys`, `/api/v1/runs` | §4a self-auth |
| `handleOutboundWebhooks` (`webhooks/routes.ts`) | `/api/webhooks/*` | session |
| `handleCustomAgents` / `handleEmployeeTools` / `handleReasonNetwork` / `handleSkillLibrary` / `handleSkills` / `handleSpaces` | §4a paths + `/api/skills*` | §4a self-auth for org paths; `/api/skills` (non-library) is gate-only |
| founder family †×13 (`founder-*-routes.ts`) | `/api/founder-skills*`, `/api/founder-{stripe,meta,hubspot}-reads*`, `/api/founder-reconciliations*`, `/api/founder-reconciliation-{schedules,slack}*`, `/api/founder-stripe-slack*` | session + workspace member (`X-Shiba-Workspace` required on several; GET-only on reads) |
| `handleOrgSandboxSettings` / `handleOrgModelKeys` | §4a | self-auth |
| `handleUserOpenAiSubscription` (`subscription-auth-routes.ts`) | `/api/subscription/openai*` | session |
| `handleSubscriptionAuth` (`auth-routes.ts`) | `/api/auth/{claude,codex,cursor,antigravity}-subscription*`, `/api/antigravity/callback` | session — these prefixes are **excluded** from `isBetterAuthPath` so they stay gated |
| `handleApprovals` (`approvals-routes.ts`) | `/api/approvals` | session |
| `handleCollaborationWithRealtime`† (`collaboration-room-routes.ts`) | `/api/collaboration/*` | session + room membership; `/realtime` is a WebSocket upgrade |
| `handleNotifications`† (`notifications/notifications-routes.ts`) | `/api/workspace-notifications*` | member |
| `handleSlackImport`† (`slack-import/routes.ts`) | `/api/slack-import*` | member |
| `handleComputers` (`computers-routes.ts`) | `/api/computers*` | session/member; pairing-token flow |
| `proxyToSandbox` (`sandbox/proxy.ts`) | preview hostnames only — **not** a path route | n/a (hostname-routed) |
| `handleDenRoutes` (`den-routes.ts`) | `/api/dens/*`, legacy `/api/captains/*` | session |
| `handleSlackCanvas` (`slack-canvas-routes.ts`) | `/api/slack-canvas`, `/api/slack-canvas/websocket` | session; WS upgrade |
| `handleRuns` (`runs-routes.ts`) | `/api/runs*`, `/api/spine`, `/api/tasks*`, `/api/employee-drafts*` | session/org; forwards to run-store DOs |
| `handleSwarm` (`swarm-routes.ts`) | `/api/swarm/{intake,share,share/{id}}` | session |
| `handleV1`† (`v1-routes.ts`) | `/api/v1/*` | `authorizeV1Request`: org API key **or** dashboard session; scope-checked per group; apiKey principals restricted to `bearerSafePath`s (else 501 `tenant_runtime_unavailable`) |
| `handleUsage` / `handleActivity` / `handleVoiceRoutes` / `handleScreenshot` / `handleE2eEvidence` / `handleInbox` / `handleMemory` / `handleFiles` / `handleNotes` / `handleKnowledge` / `handleKnowledgeProjects` / `handleKnowledgeOutputs` / `handleAudit` / `handleSandboxRoutes` | `/api/usage`, `/api/activity`, `/api/voice/transcribe`, `/api/screenshots/{id}`, `/api/e2e-evidence/{id}/*`, `/api/{mailboxes,emails*,drafts*,threads/{id}}`, `/api/memory/*`, `/api/files*`, `/api/notes*`, `/api/knowledge/search`, `/api/projects`, `/api/outputs*`, `/api/audit`, `/api/sandboxes/{id}/{info,files,file,exec,diff,processes}` | session; `handleSandboxRoutes` additionally `resolveOrgForApiRequest` + `assertAuthorizedSandboxDebug`; `handleAudit` operator-scoped |
| `handleWebSessions` (`sessions-routes.ts`) | `/api/sessions*`, `/api/rooms/{id}/websocket` | session + session ownership; WS upgrade |

### 4d. Agent DO surface

| Path | Handler | Auth |
|---|---|---|
| `/agents/coding-orchestrator/{name}/*` | inline `index.ts:676–741` | gate + `isAuthorizedSessionAgent(name, userId)` → 403; web-session names verified against the user DO; `api/`/`internal/` subpaths → 404 |
| other `/agents/*` | `routeAgentRequest` (agents SDK) | gate (401 unauthenticated) |
| `/internal/*` | inline 404 | gate first — **unauthenticated gets 401, not 404** (the 404 is post-gate) |

## 5. M09 lane (d) — static, public, `OPEN_DASHBOARD`

Pre-gate (`index.ts:329–348`) for GET/HEAD only:

| Path shape | Result | Auth |
|---|---|---|
| `/{section}` where section ∈ `MARKETING_SECTIONS` (`docs blog why-shiba privacy terms waitlist welcome`) | 301 → `https://tryshiba.dev{path}` | none |
| `/{view}` single-segment ∈ `DASHBOARD_VIEWS` (`"" work dashboard tasks threads activity analytics diff approvals swarm collaboration team agents inbox memory files notes projects outputs automations providers employee-tools integrations skills spaces custom-agents remote settings signin login slack-canvas`) | `env.ASSETS` `/app/` shell | none — static shell renders its own sign-in |
| `/auth/{forgot,reset}` | `/app/` shell | none |
| `/spaces/{id}` | `/app/` shell | none (page shell; data APIs gated) |
| `/share/{c,f}/{token}` | `/app/` shell | none (page shell; `/api/share/file/*` does the token lookup) |
| `isPublicStaticPath` GET/HEAD (`/`, `/index.html`, `/waitlist*`, `/why-shiba*`, `/docs/*`, `/_astro/*`, `/assets/*`, `/pagefind/*`, favicons, `/robots.txt`, `/sitemap*.xml`, `/llms.txt`, `/404.html`) | `env.ASSETS` | none — bypasses the gate via `isPublicRequest` |
| `OPEN_DASHBOARD=1` GET/HEAD `/`, `/app`, `/app/*`, `/assets/*` | `env.ASSETS` | none — see Findings |

Note: `handleShare`'s own `/share/c|f/{token}` GET branches
(`share-routes.ts:15–41`) are **unreachable** — the `/share/[cf]/` shell regex
at `index.ts:345` serves ASSETS first. Only `/api/share/file/{token}` reaches
the token lookup.

## 6. Findings — surprising or potentially-unintended exposure

Ordered by how much they matter for M08/M09.

1. **`OPEN_DASHBOARD=1` has no stage/prod guard.** `request-auth.ts:107`
   exempts GET/HEAD `/`, `/app`, `/app/*`, `/assets/*` unconditionally — there
   is no `stage !== "prod"` check anywhere (`env.ts` has no stage field;
   `ALCHEMY_STAGE` is deploy-time only). M08's acceptance ("`OPEN_DASHBOARD=1`
   refused when `stage=prod`") is **not implemented today** — this is the
   known gap the proposal calls out, confirmed. Effective delta vs. baseline:
   only `/app` and `/app/*` change (everything else in the exemption is already
   public via shells/static paths).
2. **Unknown paths 401 before they can 404.** An unmatched `/api/*` path
   unauthenticated → **401** (gate fires before the `index.ts:750` JSON-404
   fallback); a matched-but-unauthenticated route also 401s. M08's "unknown
   paths return 404 from day one" is therefore a **deliberate behavior
   change**: `GET /api/definitely-not-a-route` goes 401 → 404. The snapshot
   records today's 401; the route-table PR must treat this entry (and any
   other unmatched-path probes) as an expected diff, or the snapshot needs a
   carve-out. Same for unmatched non-API paths (`/not-a-real-page` → 401 today,
   would 404/ASSETS-404 after).
3. **`POST /api/waitlist` is intentionally public** — Origin allowlist +
   JSON content-type + honeypot + DO write. `GET /api/waitlist` and
   `/api/admin/waitlist` stay gated (401). By design; keep as `public` mode
   scoped to POST only.
4. **`POST /oauth/register` returns 201 to anyone** with valid
   `redirect_uris` (RFC 7591 public clients), KV-rate-limited. `POST
   /oauth/revoke` always 200. `GET/HEAD /.well-known/*` → 200. All by
   protocol design — these are the routes M09 lane (b) must keep `public`.
5. **`POST /api/automations/{id}/trigger` is exempt for every method** —
   `isAutomationWebhookPath` is path-only, so GET/PUT/DELETE also bypass the
   gate and reach the DO (which 404s non-POST). Harmless today; M09's
   `webhook:*` mode should pin `POST` or the table will widen the surface.
6. **Linear unsigned-webhook escape hatch.** With `LINEAR_WEBHOOK_SECRET`
   unset **and** `LINEAR_ALLOW_UNSIGNED_WEBHOOK=1`, `POST
   /api/linear/webhook` accepts unsigned payloads (503 otherwise). Intentional
   dev flag — flag it in review so it never ships enabled in prod.
7. **`GET /mcp` is bearer-gated but not method-restricted** — `handleMcp`
   serves any method on `/mcp*`; unauthenticated → 401 regardless. With a
   valid token, a GET reaches the MCP transport. Probably fine (transport
   decides), but the route table should decide whether `GET /mcp` is a real
   route.
8. **`handleShare` runs twice** (`index.ts:349` pre-gate, `:405` post-gate).
   The pre-gate pass answers `POST /api/share` (401 unauthenticated via its
   own check) and the public share-file GET; the post-gate pass is
   unreachable for those paths. Dead-ish duplication to collapse in M09.
9. **`/api/slack/installations/callback` is fully pre-gate** — no session at
   all; auth is the OAuth `state` param bound to a pending installation plus
   native-owner re-verification. Correct by design, but it is the only
   pre-gate route that *mutates* (completes an install → 303). Ensure the
   route table gives it an explicit mode (`oauth:callback`-like), not `public`.
10. **`GET /app` and `GET /app/` → 401** while `/` and every `DASHBOARD_VIEWS`
    id → 200 shell. `app` is not a nav id, so the bare app path is gated —
    quirky but consistent; OPEN_DASHBOARD flips it to 200.
11. **`/api/auth/*-subscription*` lanes are session-gated** even though they
    live under `/api/auth/` — `SUBSCRIPTION_AUTH_PATH` excludes them from
    `isBetterAuthPath`, so `handleBetterAuth` skips them and the gate 401s
    unauthenticated requests before `handleSubscriptionAuth` runs. Under a
    configured better-auth lane, plain `/api/auth/*` (sign-in/up/session) is
    public-by-protocol instead — the snapshot's 401s there are
    Access-posture-specific and must not be "fixed" to match.
12. **`enforceTeamMemberApiPolicy` is a no-op for unauthenticated traffic** —
    it only restricts *authenticated* invited team members. It sits post-gate
    but also sees org-API paths that skipped the gate; M09 must keep it
    mounted after surface auth, before dispatch (its own comment says so).
13. **Credential-bearing paths verified**: `/mcp` (bearer), `/api/local/*`
    (bearer/pairing), `/oauth/authorize` (session), all §2 webhooks
    (signature/secret), `/api/artifacts/download` (signed token), share links
    (token), `/api/trigger` (bearer), automation triggers (per-automation
    secret). **No route was found that reaches vault, approvals, or the
    OpenConnector gateway without one of these auth mechanisms** — every
    `/api/*` path that touches those stores sits behind the identity gate or
    an `isOrgApiPath` self-auth handler.

## 7. Test-env caveats for the snapshot

- `ASSETS` is a stub (200 for `/app*`, `/`, known static paths; 404 else) —
  statuses marked "(stub)" record *which* layer answered, not the real
  manifest's bytes.
- `Automations`/`Waitlist` DOs are faked to return the real DOs'
  auth-relevant statuses (401 invalid secret / 404 non-POST).
- Webhook secrets are **set** so signature checks — not the disabled-503 —
  produce the recorded 401s. A secrets-unset env would record 503s for the
  same paths (see `app-host-routing.test.ts`).
- `BETTER_AUTH_SECRET` unset → `/api/auth/*` non-subscription paths 401 at the
  gate. With it set, better-auth protocol endpoints become reachable (probe:
  `/api/auth/social-providers` → 200; D1-backed verbs need a real schema).
