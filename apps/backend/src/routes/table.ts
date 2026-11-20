import { handlers } from "./handlers.js";
import type { RequestContext } from "./context.js";

export type AuthMode = "session" | "access" | "signature" | "bearer" | "public" | "internal";
export type RoutePhase = "capability" | "ingress" | "authenticated" | "model";
export interface RouteEntry {
  id: string;
  phase: RoutePhase;
  method: string;
  pattern: string;
  auth: AuthMode;
  handler: (context: RequestContext) => Promise<Response | null>;
  note: string;
}

function route(
  id: string,
  phase: RoutePhase,
  method: string,
  pattern: string,
  auth: AuthMode,
  handler: RouteEntry["handler"],
  note = "",
): RouteEntry {
  return { id, phase, method, pattern, auth, handler, note };
}

// Ordered exactly as the former entry chain. Auth describes the surface contract;
// existing ingress policies and handler verification still enforce it.
export const ROUTES: readonly RouteEntry[] = [
  route("permit", "capability", "*", "^/internal/founder-automatic-read/permit$", "internal", handlers.permit, "One-purpose signed permit; verified before identity or D1."),
  route("artifactDownload", "ingress", "*", "^/api/artifacts/download$", "signature", handlers.artifactDownload, "Signed archive capability; public landing only, verified download token."),
  route("fileAppPreviewResponse", "ingress", "*", "^/api/files/[^/]+/app-preview$", "access", handlers.fileAppPreviewResponse, "Verified Access identity, active workspace and personal file ownership; reads only, before session refresh and model preflight."),
  route("betterAuthResponse", "ingress", "*", "^/api/auth/", "public", handlers.betterAuthResponse, "Sign-in protocol; package excludes subscription routes and verifies protected verbs."),
  route("callback", "ingress", "*", "^/api/slack/installations/callback$", "public", handlers.callback, "OAuth callback validates pending state and original owner."),
  route("discordInstallCallback", "ingress", "GET", "^/api/discord/installations/callback$", "public", handlers.discordInstallationResponse, "OAuth callback validates single-use state and the original dashboard user."),
  route("dev-oauth-post", "ingress", "POST", "^/api/dev/oauth-loopback$", "signature", handlers.devOAuthLoopbackResponse, "Loopback host and shared header secret required."),
  route("dev-oauth-session", "ingress", "*", "^/api/dev/oauth-loopback$", "session", handlers.devOAuthLoopbackResponse, "GET requires session and pending OAuth state; other methods return 405."),
  route("shell", "ingress", "GET", "^(?:/(?:docs|blog|why-shiba|privacy|terms|waitlist|welcome)(?:/|$)|/(?:slack-canvas|signin|login||work|dashboard|tasks|threads|activity|analytics|diff|approvals|swarm|collaboration|team|agents|inbox|memory|files|notes|projects|outputs|automations|providers|employee-tools|integrations|skills|spaces|custom-agents|remote|settings)/?$|/auth/(?:forgot|reset)/?$|/spaces/[^/]+/?$|/share/[cf]/[^/]+/?$)", "public", handlers.shell, "Read-only marketing redirect or dashboard shell; no private API data."),
  route("shell-head", "ingress", "HEAD", "^(?:/(?:docs|blog|why-shiba|privacy|terms|waitlist|welcome)(?:/|$)|/(?:slack-canvas|signin|login||work|dashboard|tasks|threads|activity|analytics|diff|approvals|swarm|collaboration|team|agents|inbox|memory|files|notes|projects|outputs|automations|providers|employee-tools|integrations|skills|spaces|custom-agents|remote|settings)/?$|/auth/(?:forgot|reset)/?$|/spaces/[^/]+/?$|/share/[cf]/[^/]+/?$)", "public", handlers.shell, "Read-only marketing redirect or dashboard shell; no private API data."),
  route("share-read", "ingress", "GET", "^(?:/share/[cf]/[^/]+|/api/share/file/[^/]+)$", "public", handlers.publicShareResponse, "Token capability read; unknown/expired tokens fail closed."),
  route("share-early-management", "ingress", "*", "^/api/share$", "session", handlers.publicShareResponse, "Management retains its own session verification."),
  route("employeeAccessResponse", "authenticated", "*", "^/api/governance/employees/[^/]+/access/?$", "session", handlers.employeeAccessResponse),
  route("adminFlagsResponse", "authenticated", "GET", "^/api/admin/flags$", "session", handlers.adminFlagsResponse, "Deployment-operator read of the runtime flag registry; secret values are never exposed."),
  route("observabilityResponse", "authenticated", "*", "^/api/observability$", "session", handlers.observabilityResponse),
  route("outputArchiveResponse", "authenticated", "*", "^/api/run-output-archives(?:/|$)", "session", handlers.outputArchiveResponse),
  route("slackInstallationResponse", "authenticated", "*", "^/api/slack/installations(?:/|$)", "session", handlers.slackInstallationResponse),
  route("discordInstallationResponse", "authenticated", "*", "^/api/discord/installations(?:/|$)", "session", handlers.discordInstallationResponse),
  route("teamsConnectionResponse", "authenticated", "*", "^/api/teams/connection$", "session", handlers.teamsConnectionResponse, "Native owner of the configured workspace; writes require the same origin."),
  route("slackCoworkerResponse", "authenticated", "*", "^/api/slack/coworker(?:/|$)", "session", handlers.slackCoworkerResponse),
  route("sharedComputerResponse", "authenticated", "*", "^/api/shared-computers(?:/|$)", "session", handlers.sharedComputerResponse),
  route("workspaceIntegrationResponse", "authenticated", "*", "^/api/workspace-integrations(?:/|$)", "session", handlers.workspaceIntegrationResponse),
  route("browserResponse", "authenticated", "*", "^/api/(?:sessions/browser|browser-logins(?:/[^/]+)?)$", "session", handlers.browserResponse),
  route("personalExecutionResponse", "authenticated", "*", "^/api/personal-execution(?:/|$)", "session", handlers.personalExecutionResponse),
  route("teamModelResponse", "authenticated", "*", "^/api/team-model-sessions(?:/|$)", "session", handlers.teamModelResponse),
  route("learningResponse", "authenticated", "*", "^/api/learning(?:/|$)", "session", handlers.learningResponse),
  route("workResponse", "authenticated", "*", "^/api/(?:needs-you(?:/dismiss)?$|workspaces/[^/]+/work)", "session", handlers.workResponse),
  route("primaryBotResponse", "authenticated", "*", "^/api/workspaces/[^/]+/primary-bot", "session", handlers.primaryBotResponse),
  route("searchResponse", "authenticated", "*", "^/api/search$", "session", handlers.searchResponse),
  route("paletteResponse", "authenticated", "*", "^/api/palette/", "session", handlers.paletteResponse),
  route("askUserResponse", "authenticated", "*", "^/api/runs/[^/]+/ask-user/", "session", handlers.askUserResponse),
  route("uiBlockResponse", "authenticated", "*", "^/api/runs/[^/]+/ui-blocks(?:/|$)", "session", handlers.uiBlockResponse),
  route("workspaceResponse", "authenticated", "*", "^/api/workspaces(?:/|$)", "session", handlers.workspaceResponse),
  route("governanceResponse", "authenticated", "*", "^/api/governance", "session", handlers.governanceResponse),
  route("share-late", "authenticated", "*", "^/api/share$", "session", handlers.shareResponse, "Second legacy share invocation after ingress policies."),
  route("emailDeliveryResponse", "authenticated", "*", "^/api/email/delivery-status$", "session", handlers.emailDeliveryResponse),
  route("seedResponse", "authenticated", "*", "^/api/first-run-seed$", "session", handlers.seedResponse),
  route("bundleResponse", "authenticated", "*", "^/api/employee-bundles", "session", handlers.bundleResponse),
  route("gmailResponse", "authenticated", "*", "^/api/connections/gmail(?:/|$)", "session", handlers.gmailResponse),
  route("oauth-public", "authenticated", "*", "^(?:/\\.well-known/oauth-(?:authorization-server|protected-resource)|/oauth/(?:register|token|revoke))$", "public", handlers.oauthResponse, "OAuth discovery and client protocol; handler validates grants."),
  route("oauth-consent", "authenticated", "*", "^/oauth/authorize$", "session", handlers.oauthResponse, "Browser consent requires session."),
  route("waitlist-signup", "authenticated", "*", "^/api/waitlist$", "public", handlers.waitlistResponse, "Anonymous signup; public ingress permits POST only."),
  route("waitlist-admin", "authenticated", "*", "^/api/admin/waitlist$", "session", handlers.waitlistResponse),
  route("callbackMethod", "authenticated", "*", "^/api/(?:slack/(?:events|command|interact)|telegram/webhook|discord/interactions|github/webhook|linear/webhook|sentry/webhook|trigger)$", "signature", handlers.callbackMethod),
  route("health", "authenticated", "*", "^/api/health$", "public", handlers.metaResponse, "Read-only health; ingress permits GET/HEAD only."),
  route("metadata", "authenticated", "*", "^/api/(?:whoami$|email/openapi\\.json$|setup/|agents$|model-config)", "session", handlers.metaResponse),
  route("workspaceEventsResponse", "authenticated", "*", "^/api/workspaces/[^/]+/events$", "session", handlers.workspaceEventsResponse, "Existing precedence: workspace handler consumes this path first."),
  route("teamOnboardingTask", "authenticated", "*", "^/api/onboarding/progress/team-task$", "session", handlers.teamOnboardingTask),
  route("onboardingResponse", "authenticated", "*", "^/api/onboarding/progress$", "session", handlers.onboardingResponse),
  route("acpProviderResponse", "authenticated", "*", "^/api/providers(?:/|$)", "session", handlers.acpProviderResponse),
  route("capabilityCatalogResponse", "authenticated", "*", "^/api/capabilities(?:/invocations)?$", "session", handlers.capabilityCatalogResponse),
  route("apiKeysResponse", "authenticated", "*", "^/api/api-keys$", "bearer", handlers.apiKeysResponse, "Session or scoped API bearer, verified by org resolver."),
  route("outboundWebhooksResponse", "authenticated", "*", "^/api/webhooks", "session", handlers.outboundWebhooksResponse),
  route("customAgentsResponse", "authenticated", "*", "^/api/custom-agents", "bearer", handlers.customAgentsResponse, "Session or scoped API bearer, verified by org resolver."),
  route("employeeToolsResponse", "authenticated", "*", "^/api/employee-tools", "bearer", handlers.employeeToolsResponse, "Session or scoped API bearer, verified by org resolver."),
  route("reasonNetworkResponse", "authenticated", "*", "^/api/reason-network(?:/|$)", "session", handlers.reasonNetworkResponse),
  route("skillLibraryResponse", "authenticated", "*", "^/api/skills/library", "bearer", handlers.skillLibraryResponse, "Session or scoped API bearer, verified by org resolver."),
  route("skillsResponse", "authenticated", "*", "^/api/skills", "session", handlers.skillsResponse),
  route("spacesResponse", "authenticated", "*", "^/api/spaces", "bearer", handlers.spacesResponse, "Session or scoped API bearer, verified by org resolver."),
  route("founderConnectorResponse", "authenticated", "*", "^/api/founder-skills/[^/]+/connector-job", "session", handlers.founderConnectorResponse),
  route("reportSlackResponse", "authenticated", "*", "^/api/founder-skills/[^/]+/reports/[^/]+/slack", "session", handlers.reportSlackResponse),
  route("founderAutomaticResponse", "authenticated", "*", "^/api/founder-skills/[^/]+/automatic-reads", "session", handlers.founderAutomaticResponse),
  route("founderStripeResponse", "authenticated", "*", "^/api/founder-stripe-reads", "session", handlers.founderStripeResponse),
  route("founderMetaResponse", "authenticated", "*", "^/api/founder-meta-reads", "session", handlers.founderMetaResponse),
  route("founderHubSpotResponse", "authenticated", "*", "^/api/founder-hubspot-reads", "session", handlers.founderHubSpotResponse),
  route("reconciliationResponse", "authenticated", "*", "^/api/founder-reconciliations", "session", handlers.reconciliationResponse),
  route("standingComparisonResponse", "authenticated", "*", "^/api/founder-reconciliation-schedules", "session", handlers.standingComparisonResponse),
  route("reconciliationSlackResponse", "authenticated", "*", "^/api/founder-reconciliation-slack(?:/|$)", "session", handlers.reconciliationSlackResponse),
  route("stripeSlackResponse", "authenticated", "*", "^/api/founder-stripe-slack(?:/|$)", "session", handlers.stripeSlackResponse),
  route("founderAutomaticSlackResponse", "authenticated", "*", "^/api/founder-skills/[^/]+/automatic-slack", "session", handlers.founderAutomaticSlackResponse),
  route("founderEvidenceResponse", "authenticated", "*", "^/api/founder-skills/[^/]+/reports", "session", handlers.founderEvidenceResponse),
  route("founderSkillsResponse", "authenticated", "*", "^/api/founder-skills", "session", handlers.founderSkillsResponse),
  route("orgSandboxResponse", "authenticated", "*", "^/api/org/sandbox(?:/test)?$", "bearer", handlers.orgSandboxResponse, "Session or scoped API bearer, verified by org resolver."),
  route("orgModelKeysResponse", "authenticated", "*", "^/api/org/model-keys", "bearer", handlers.orgModelKeysResponse, "Session or scoped API bearer, verified by org resolver."),
  route("userOpenAiSubscriptionResponse", "authenticated", "*", "^/api/subscription/openai", "session", handlers.userOpenAiSubscriptionResponse),
  route("subscriptionAuthResponse", "authenticated", "*", "^/api/(?:auth/(?:claude|codex|cursor|antigravity)-subscription|antigravity/callback)", "session", handlers.subscriptionAuthResponse),
  route("mcpResponse", "authenticated", "*", "^/mcp(?:/|$)", "bearer", handlers.mcpResponse),
  route("local", "authenticated", "*", "^/api/local(?:/|$)", "bearer", handlers.local),
  route("internal", "authenticated", "*", "^/internal/", "internal", handlers.internal),
  route("approvalsResponse", "authenticated", "*", "^/api/approvals$", "session", handlers.approvalsResponse),
  route("collaborationResponse", "authenticated", "*", "^/api/collaboration(?:/|$)", "session", handlers.collaborationResponse),
  route("notificationsResponse", "authenticated", "*", "^/api/workspace-notifications(?:/|$)", "session", handlers.notificationsResponse),
  route("slackImportResponse", "authenticated", "*", "^/api/slack-import(?:/|$)", "session", handlers.slackImportResponse),
  route("computersResponse", "authenticated", "*", "^/api/computers(?:/|$)", "session", handlers.computersResponse),
  route("sandboxResponse", "model", "*", "^/", "session", handlers.sandboxResponse, "SDK inspects request and returns null when not applicable."),
  route("denResponse", "model", "*", "^/api/(?:dens|captains)/", "session", handlers.denResponse),
  route("slackCanvasResponse", "model", "*", "^/api/slack-canvas(?:/websocket)?$", "access", handlers.slackCanvasResponse),
  route("runsResponse", "model", "*", "^/api/(?:runs|spine|tasks|employee-drafts)", "session", handlers.runsResponse),
  route("swarmResponse", "model", "*", "^/api/swarm/", "session", handlers.swarmResponse),
  route("v1-schema", "model", "*", "^/api/v1/openapi\\.json$", "public", handlers.v1Response, "Published API schema; ingress permits GET only."),
  route("v1", "model", "*", "^/api/v1/(?!openapi\\.json$)", "session", handlers.v1Response, "Public GET schema; other routes require session at ingress, scoped bearer only on org-exempt paths."),
  route("usageResponse", "model", "*", "^/api/usage$", "session", handlers.usageResponse),
  route("billingWebhook", "model", "*", "^/api/billing/stripe/webhook$", "signature", handlers.billingResponse, "Stripe-Signature HMAC verified inside handler."),
  route("billing", "model", "*", "^/api/billing(?:$|/(?:checkout|portal)$)", "session", handlers.billingResponse),
  route("voiceResponse", "model", "*", "^/api/voice/transcribe$", "session", handlers.voiceResponse),
  route("activityResponse", "model", "*", "^/api/activity$", "session", handlers.activityResponse),
  route("screenshotResponse", "model", "*", "^/api/screenshots/", "session", handlers.screenshotResponse),
  route("e2eEvidenceResponse", "model", "*", "^/api/e2e-evidence/", "session", handlers.e2eEvidenceResponse),
  route("webSessionsResponse", "model", "*", "^/api/(?:sessions|rooms/[^/]+/websocket)", "session", handlers.webSessionsResponse),
  route("inboxResponse", "model", "*", "^/api/(?:mailboxes|emails|emails-search|threads/|drafts)", "session", handlers.inboxResponse),
  route("memoryResponse", "model", "*", "^/api/memory/", "session", handlers.memoryResponse),
  route("filesResponse", "model", "*", "^/api/files", "session", handlers.filesResponse),
  route("notesResponse", "model", "*", "^/api/notes", "session", handlers.notesResponse),
  route("knowledgeResponse", "model", "*", "^/api/knowledge/search$", "session", handlers.knowledgeResponse),
  route("projectsResponse", "model", "*", "^/api/projects$", "session", handlers.projectsResponse),
  route("outputsResponse", "model", "*", "^/api/outputs", "session", handlers.outputsResponse),
  route("auditResponse", "model", "*", "^/api/audit$", "session", handlers.auditResponse),
  route("sandboxRouteResponse", "model", "*", "^/api/sandboxes/", "session", handlers.sandboxRouteResponse),
  route("telegramResponse", "model", "*", "^/api/telegram/webhook$", "signature", handlers.telegramResponse, "Telegram shared header secret."),
  route("discordResponse", "model", "*", "^/api/discord/interactions$", "signature", handlers.discordResponse),
  route("teamsResponse", "model", "*", "^/api/teams/messages$", "signature", handlers.teamsResponse, "Bot Framework JWT verified inside handler."),
  route("managedSlackResponse", "model", "*", "^/api/slack/(?:events|command|interact)$", "signature", handlers.managedSlackResponse),
  route("slackEventsResponse", "model", "*", "^/api/slack/events$", "signature", handlers.slackEventsResponse),
  route("slackResponse", "model", "*", "^/api/slack/command$", "signature", handlers.slackResponse),
  route("triggerResponse", "model", "*", "^/api/trigger$", "bearer", handlers.triggerResponse),
  route("slackInteractResponse", "model", "*", "^/api/slack/interact$", "signature", handlers.slackInteractResponse),
  route("automation-trigger", "model", "*", "^/api/automations/[^/]+/trigger/?$", "bearer", handlers.automationsResponse, "Webhook bearer verified inside handler."),
  route("automations", "model", "*", "^/api/automations(?:$|/(?![^/]+/trigger/?$))", "session", handlers.automationsResponse),
  route("webhookResponse", "model", "*", "^/api/github/webhook$", "signature", handlers.webhookResponse),
  route("linearWebhookResponse", "model", "*", "^/api/linear/webhook$", "signature", handlers.linearWebhookResponse),
  route("integrationsResponse", "model", "*", "^/api/integrations/", "session", handlers.integrationsResponse),
  route("enrollment", "model", "*", "^/api/operator-enrollment-reviews(?:/|$)", "session", handlers.enrollment),
  route("provider-callback", "model", "*", "^/api/integrations/provider/callback$", "public", handlers.integrationProviderResponse, "OAuth callback with state; ingress permits GET only."),
  route("provider", "model", "*", "^/api/integrations/provider(?:$|/(?!callback$))", "session", handlers.integrationProviderResponse),
  route("sentryResponse", "model", "*", "^/api/sentry/webhook$", "signature", handlers.sentryResponse),
  route("agents", "model", "*", "^/agents/", "session", handlers.agents),
  route("agentResponse", "model", "*", "^/", "session", handlers.agentResponse, "SDK inspects request and returns null when not applicable."),
  route("apiMiss", "model", "*", "^/api/", "session", handlers.apiMiss),
  route("public-static", "model", "GET", "^/(?:$|index\\.html$|(?:waitlist|why-shiba)(?:/|/index\\.html)?$|docs(?:/|$)|(?:_astro|assets|pagefind)/|favicon(?:\\.ico|\\.svg|-32x32\\.png)$|robots\\.txt$|sitemap(?:-index|-0)?\\.xml$|llms\\.txt$|404\\.html$)", "public", handlers.assets, "Read-only public site assets under the existing ingress policy."),
  route("public-static-head", "model", "HEAD", "^/(?:$|index\\.html$|(?:waitlist|why-shiba)(?:/|/index\\.html)?$|docs(?:/|$)|(?:_astro|assets|pagefind)/|favicon(?:\\.ico|\\.svg|-32x32\\.png)$|robots\\.txt$|sitemap(?:-index|-0)?\\.xml$|llms\\.txt$|404\\.html$)", "public", handlers.assets, "Read-only public site assets under the existing ingress policy."),
  route("assets", "model", "*", "^/", "session", handlers.assets),
];

export function matchesRoute(route: RouteEntry, request: Request): boolean {
  return (
    (route.method === "*" || route.method === request.method) &&
    new RegExp(route.pattern).test(new URL(request.url).pathname)
  );
}

export async function dispatchRoutes(
  phase: RoutePhase,
  context: RequestContext,
  onResponse?: (routeId: string) => void,
): Promise<Response | null> {
  for (const entry of ROUTES) {
    if (entry.phase !== phase || !matchesRoute(entry, context.request)) continue;
    const response = await entry.handler(context);
    if (response) {
      onResponse?.(entry.id);
      return response;
    }
  }
  return null;
}
