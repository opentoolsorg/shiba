# Routes

Generated from `apps/backend/src/routes/table.ts`. Run `node scripts/generate-routes.mjs` to update; CI runs the same script with `--check`.

Entries appear in dispatch order. Patterns are regular expressions; `*` accepts every method. Thin adapters retain exact matching, method checks, and return-null behavior.

Auth metadata records existing per-surface verification together with ingress gates. A session may use the built-in login or verified Access identity; bearer notes identify surfaces that also accept a scoped API key. Public means an explicitly reviewed anonymous surface, including protocol endpoints and token capability reads. It does not grant private API access. Handlers retain their own verification.

Phase boundaries preserve precedence: `capability` runs before identity verification, `ingress` before the shared authentication gate, `authenticated` after authentication and team-member policy, and `model` after live-model validation.

| ID | Phase | Method | Pattern | Auth | Note |
| --- | --- | --- | --- | --- | --- |
| permit | capability | `*` | `^/internal/founder-automatic-read/permit$` | internal | One-purpose signed permit; verified before identity or D1. |
| artifactDownload | ingress | `*` | `^/api/artifacts/download$` | signature | Signed archive capability; public landing only, verified download token. |
| fileAppPreviewResponse | ingress | `*` | `^/api/files/[^/]+/app-preview$` | access | Verified Access identity, active workspace and personal file ownership; reads only, before session refresh and model preflight. |
| betterAuthResponse | ingress | `*` | `^/api/auth/` | public | Sign-in protocol; package excludes subscription routes and verifies protected verbs. |
| callback | ingress | `*` | `^/api/slack/installations/callback$` | public | OAuth callback validates pending state and original owner. |
| discordInstallCallback | ingress | `GET` | `^/api/discord/installations/callback$` | public | OAuth callback validates single-use state and the original dashboard user. |
| dev-oauth-post | ingress | `POST` | `^/api/dev/oauth-loopback$` | signature | Loopback host and shared header secret required. |
| dev-oauth-session | ingress | `*` | `^/api/dev/oauth-loopback$` | session | GET requires session and pending OAuth state; other methods return 405. |
| shell | ingress | `GET` | `^(?:/(?:docs\|blog\|why-shiba\|privacy\|terms\|waitlist\|welcome)(?:/\|$)\|/(?:slack-canvas\|signin\|login\|\|work\|dashboard\|tasks\|threads\|activity\|analytics\|diff\|approvals\|swarm\|collaboration\|team\|agents\|inbox\|memory\|files\|notes\|projects\|outputs\|automations\|providers\|employee-tools\|integrations\|skills\|spaces\|chief-of-staff\|custom-agents\|remote\|settings)/?$\|/auth/(?:forgot\|reset)/?$\|/spaces/[^/]+/?$\|/share/[cf]/[^/]+/?$)` | public | Read-only marketing redirect or dashboard shell; no private API data. |
| shell-head | ingress | `HEAD` | `^(?:/(?:docs\|blog\|why-shiba\|privacy\|terms\|waitlist\|welcome)(?:/\|$)\|/(?:slack-canvas\|signin\|login\|\|work\|dashboard\|tasks\|threads\|activity\|analytics\|diff\|approvals\|swarm\|collaboration\|team\|agents\|inbox\|memory\|files\|notes\|projects\|outputs\|automations\|providers\|employee-tools\|integrations\|skills\|spaces\|chief-of-staff\|custom-agents\|remote\|settings)/?$\|/auth/(?:forgot\|reset)/?$\|/spaces/[^/]+/?$\|/share/[cf]/[^/]+/?$)` | public | Read-only marketing redirect or dashboard shell; no private API data. |
| share-read | ingress | `GET` | `^(?:/share/[cf]/[^/]+\|/api/share/file/[^/]+)$` | public | Token capability read; unknown/expired tokens fail closed. |
| share-early-management | ingress | `*` | `^/api/share$` | session | Management retains its own session verification. |
| employeeAccessResponse | authenticated | `*` | `^/api/governance/employees/[^/]+/access/?$` | session |  |
| adminFlagsResponse | authenticated | `GET` | `^/api/admin/flags$` | session | Deployment-operator read of the runtime flag registry; secret values are never exposed. |
| observabilityResponse | authenticated | `*` | `^/api/observability$` | session |  |
| outputArchiveResponse | authenticated | `*` | `^/api/run-output-archives(?:/\|$)` | session |  |
| slackInstallationResponse | authenticated | `*` | `^/api/slack/installations(?:/\|$)` | session |  |
| discordInstallationResponse | authenticated | `*` | `^/api/discord/installations(?:/\|$)` | session |  |
| teamsConnectionResponse | authenticated | `*` | `^/api/teams/connection$` | session | Native owner of the configured workspace; writes require the same origin. |
| slackCoworkerResponse | authenticated | `*` | `^/api/slack/coworker(?:/\|$)` | session |  |
| sharedComputerResponse | authenticated | `*` | `^/api/shared-computers(?:/\|$)` | session |  |
| workspaceIntegrationResponse | authenticated | `*` | `^/api/workspace-integrations(?:/\|$)` | session |  |
| browserResponse | authenticated | `*` | `^/api/(?:sessions/browser\|browser-logins(?:/[^/]+)?)$` | session |  |
| personalExecutionResponse | authenticated | `*` | `^/api/personal-execution(?:/\|$)` | session |  |
| teamModelResponse | authenticated | `*` | `^/api/team-model-sessions(?:/\|$)` | session |  |
| learningResponse | authenticated | `*` | `^/api/learning(?:/\|$)` | session |  |
| workResponse | authenticated | `*` | `^/api/(?:needs-you(?:/dismiss)?$\|workspaces/[^/]+/work)` | session |  |
| primaryBotResponse | authenticated | `*` | `^/api/workspaces/[^/]+/primary-bot` | session |  |
| searchResponse | authenticated | `*` | `^/api/search$` | session |  |
| paletteResponse | authenticated | `*` | `^/api/palette/` | session |  |
| askUserResponse | authenticated | `*` | `^/api/runs/[^/]+/ask-user/` | session |  |
| uiBlockResponse | authenticated | `*` | `^/api/runs/[^/]+/ui-blocks(?:/\|$)` | session |  |
| workspaceResponse | authenticated | `*` | `^/api/workspaces(?:/\|$)` | session |  |
| governanceResponse | authenticated | `*` | `^/api/governance` | session |  |
| share-late | authenticated | `*` | `^/api/share$` | session | Second legacy share invocation after ingress policies. |
| emailDeliveryResponse | authenticated | `*` | `^/api/email/delivery-status$` | session |  |
| seedResponse | authenticated | `*` | `^/api/first-run-seed$` | session |  |
| bundleResponse | authenticated | `*` | `^/api/employee-bundles` | session |  |
| gmailResponse | authenticated | `*` | `^/api/connections/gmail(?:/\|$)` | session |  |
| oauth-public | authenticated | `*` | `^(?:/\.well-known/oauth-(?:authorization-server\|protected-resource)\|/oauth/(?:register\|token\|revoke))$` | public | OAuth discovery and client protocol; handler validates grants. |
| oauth-consent | authenticated | `*` | `^/oauth/authorize$` | session | Browser consent requires session. |
| waitlist-signup | authenticated | `*` | `^/api/waitlist$` | public | Anonymous signup; public ingress permits POST only. |
| waitlist-admin | authenticated | `*` | `^/api/admin/waitlist$` | session |  |
| callbackMethod | authenticated | `*` | `^/api/(?:slack/(?:events\|command\|interact)\|telegram/webhook\|discord/interactions\|github/webhook\|linear/webhook\|sentry/webhook\|trigger)$` | signature |  |
| health | authenticated | `*` | `^/api/health$` | public | Read-only health; ingress permits GET/HEAD only. |
| metadata | authenticated | `*` | `^/api/(?:whoami$\|email/openapi\.json$\|setup/\|agents$\|model-config)` | session |  |
| workspaceEventsResponse | authenticated | `*` | `^/api/workspaces/[^/]+/events$` | session | Existing precedence: workspace handler consumes this path first. |
| teamOnboardingTask | authenticated | `*` | `^/api/onboarding/progress/team-task$` | session |  |
| onboardingResponse | authenticated | `*` | `^/api/onboarding/progress$` | session |  |
| acpProviderResponse | authenticated | `*` | `^/api/providers(?:/\|$)` | session |  |
| capabilityCatalogResponse | authenticated | `*` | `^/api/capabilities(?:/invocations)?$` | session |  |
| apiKeysResponse | authenticated | `*` | `^/api/api-keys$` | bearer | Session or scoped API bearer, verified by org resolver. |
| outboundWebhooksResponse | authenticated | `*` | `^/api/webhooks` | session |  |
| customAgentsResponse | authenticated | `*` | `^/api/custom-agents` | bearer | Session or scoped API bearer, verified by org resolver. |
| employeeToolsResponse | authenticated | `*` | `^/api/employee-tools` | bearer | Session or scoped API bearer, verified by org resolver. |
| reasonNetworkResponse | authenticated | `*` | `^/api/reason-network(?:/\|$)` | session |  |
| skillLibraryResponse | authenticated | `*` | `^/api/skills/library` | bearer | Session or scoped API bearer, verified by org resolver. |
| skillsResponse | authenticated | `*` | `^/api/skills` | session |  |
| spacesResponse | authenticated | `*` | `^/api/spaces` | bearer | Session or scoped API bearer, verified by org resolver. |
| founderConnectorResponse | authenticated | `*` | `^/api/founder-skills/[^/]+/connector-job` | session |  |
| reportSlackResponse | authenticated | `*` | `^/api/founder-skills/[^/]+/reports/[^/]+/slack` | session |  |
| founderAutomaticResponse | authenticated | `*` | `^/api/founder-skills/[^/]+/automatic-reads` | session |  |
| founderStripeResponse | authenticated | `*` | `^/api/founder-stripe-reads` | session |  |
| founderMetaResponse | authenticated | `*` | `^/api/founder-meta-reads` | session |  |
| founderHubSpotResponse | authenticated | `*` | `^/api/founder-hubspot-reads` | session |  |
| reconciliationResponse | authenticated | `*` | `^/api/founder-reconciliations` | session |  |
| standingComparisonResponse | authenticated | `*` | `^/api/founder-reconciliation-schedules` | session |  |
| reconciliationSlackResponse | authenticated | `*` | `^/api/founder-reconciliation-slack(?:/\|$)` | session |  |
| stripeSlackResponse | authenticated | `*` | `^/api/founder-stripe-slack(?:/\|$)` | session |  |
| founderAutomaticSlackResponse | authenticated | `*` | `^/api/founder-skills/[^/]+/automatic-slack` | session |  |
| founderEvidenceResponse | authenticated | `*` | `^/api/founder-skills/[^/]+/reports` | session |  |
| founderSkillsResponse | authenticated | `*` | `^/api/founder-skills` | session |  |
| orgSandboxResponse | authenticated | `*` | `^/api/org/sandbox(?:/test)?$` | bearer | Session or scoped API bearer, verified by org resolver. |
| orgModelKeysResponse | authenticated | `*` | `^/api/org/model-keys` | bearer | Session or scoped API bearer, verified by org resolver. |
| userOpenAiSubscriptionResponse | authenticated | `*` | `^/api/subscription/openai` | session |  |
| subscriptionAuthResponse | authenticated | `*` | `^/api/(?:auth/(?:claude\|codex\|cursor\|antigravity)-subscription\|antigravity/callback)` | session |  |
| mcpResponse | authenticated | `*` | `^/mcp(?:/\|$)` | bearer |  |
| local | authenticated | `*` | `^/api/local(?:/\|$)` | bearer |  |
| internal | authenticated | `*` | `^/internal/` | internal |  |
| approvalsResponse | authenticated | `*` | `^/api/approvals$` | session |  |
| collaborationResponse | authenticated | `*` | `^/api/collaboration(?:/\|$)` | session |  |
| notificationsResponse | authenticated | `*` | `^/api/workspace-notifications(?:/\|$)` | session |  |
| slackImportResponse | authenticated | `*` | `^/api/slack-import(?:/\|$)` | session |  |
| computersResponse | authenticated | `*` | `^/api/computers(?:/\|$)` | session |  |
| sandboxResponse | model | `*` | `^/` | session | SDK inspects request and returns null when not applicable. |
| denResponse | model | `*` | `^/api/(?:dens\|captains)/` | session |  |
| slackCanvasResponse | model | `*` | `^/api/slack-canvas(?:/websocket)?$` | access |  |
| runsResponse | model | `*` | `^/api/(?:runs\|spine\|tasks\|employee-drafts)` | session |  |
| swarmResponse | model | `*` | `^/api/swarm/` | session |  |
| v1-schema | model | `*` | `^/api/v1/openapi\.json$` | public | Published API schema; ingress permits GET only. |
| v1 | model | `*` | `^/api/v1/(?!openapi\.json$)` | session | Public GET schema; other routes require session at ingress, scoped bearer only on org-exempt paths. |
| usageResponse | model | `*` | `^/api/usage$` | session |  |
| billingWebhook | model | `*` | `^/api/billing/stripe/webhook$` | signature | Stripe-Signature HMAC verified inside handler. |
| billing | model | `*` | `^/api/billing(?:$\|/(?:checkout\|portal)$)` | session |  |
| voiceResponse | model | `*` | `^/api/voice/transcribe$` | session |  |
| activityResponse | model | `*` | `^/api/activity$` | session |  |
| screenshotResponse | model | `*` | `^/api/screenshots/` | session |  |
| e2eEvidenceResponse | model | `*` | `^/api/e2e-evidence/` | session |  |
| webSessionsResponse | model | `*` | `^/api/(?:sessions\|rooms/[^/]+/websocket)` | session |  |
| inboxResponse | model | `*` | `^/api/(?:mailboxes\|emails\|emails-search\|threads/\|drafts)` | session |  |
| memoryResponse | model | `*` | `^/api/memory/` | session |  |
| filesResponse | model | `*` | `^/api/files` | session |  |
| notesResponse | model | `*` | `^/api/notes` | session |  |
| knowledgeResponse | model | `*` | `^/api/knowledge/search$` | session |  |
| projectsResponse | model | `*` | `^/api/projects$` | session |  |
| outputsResponse | model | `*` | `^/api/outputs` | session |  |
| auditResponse | model | `*` | `^/api/audit$` | session |  |
| sandboxRouteResponse | model | `*` | `^/api/sandboxes/` | session |  |
| telegramResponse | model | `*` | `^/api/telegram/webhook$` | signature | Telegram shared header secret. |
| discordResponse | model | `*` | `^/api/discord/interactions$` | signature |  |
| teamsResponse | model | `*` | `^/api/teams/messages$` | signature | Bot Framework JWT verified inside handler. |
| managedSlackResponse | model | `*` | `^/api/slack/(?:events\|command\|interact)$` | signature |  |
| slackEventsResponse | model | `*` | `^/api/slack/events$` | signature |  |
| slackResponse | model | `*` | `^/api/slack/command$` | signature |  |
| triggerResponse | model | `*` | `^/api/trigger$` | bearer |  |
| slackInteractResponse | model | `*` | `^/api/slack/interact$` | signature |  |
| automation-trigger | model | `*` | `^/api/automations/[^/]+/trigger/?$` | bearer | Webhook bearer verified inside handler. |
| automations | model | `*` | `^/api/automations(?:$\|/(?![^/]+/trigger/?$))` | session |  |
| webhookResponse | model | `*` | `^/api/github/webhook$` | signature |  |
| linearWebhookResponse | model | `*` | `^/api/linear/webhook$` | signature |  |
| integrationsResponse | model | `*` | `^/api/integrations/` | session |  |
| enrollment | model | `*` | `^/api/operator-enrollment-reviews(?:/\|$)` | session |  |
| provider-callback | model | `*` | `^/api/integrations/provider/callback$` | public | OAuth callback with state; ingress permits GET only. |
| provider | model | `*` | `^/api/integrations/provider(?:$\|/(?!callback$))` | session |  |
| sentryResponse | model | `*` | `^/api/sentry/webhook$` | signature |  |
| agents | model | `*` | `^/agents/` | session |  |
| agentResponse | model | `*` | `^/` | session | SDK inspects request and returns null when not applicable. |
| apiMiss | model | `*` | `^/api/` | session |  |
| public-static | model | `GET` | `^/(?:$\|index\.html$\|(?:waitlist\|why-shiba)(?:/\|/index\.html)?$\|docs(?:/\|$)\|(?:_astro\|assets\|pagefind)/\|favicon(?:\.ico\|\.svg\|-32x32\.png)$\|robots\.txt$\|sitemap(?:-index\|-0)?\.xml$\|llms\.txt$\|404\.html$)` | public | Read-only public site assets under the existing ingress policy. |
| public-static-head | model | `HEAD` | `^/(?:$\|index\.html$\|(?:waitlist\|why-shiba)(?:/\|/index\.html)?$\|docs(?:/\|$)\|(?:_astro\|assets\|pagefind)/\|favicon(?:\.ico\|\.svg\|-32x32\.png)$\|robots\.txt$\|sitemap(?:-index\|-0)?\.xml$\|llms\.txt$\|404\.html$)` | public | Read-only public site assets under the existing ingress policy. |
| assets | model | `*` | `^/` | session |  |
