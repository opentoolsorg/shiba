/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { getAgentByName, routeAgentRequest } from "agents/routing";
import { OpenCodeAgent } from "./agents/opencode-agent.js";
import { CodingOrchestrator } from "./agents/orchestrator.js";
import { ExplorerAgent } from "./agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "./agents/specialists/reviewer-agent.js";
import { handleArtifactDownload } from "./artifact-download.js";
import { AUDIT_RETENTION_MS, pruneAuditLog } from "./audit.js";
import { Automations } from "./automations-do.js";
import { automationsStub, seenDelivery } from "./automations-stub.js";
import { ensureLiveCodingModel } from "./coding-model.js";
import { handleInboundEmail } from "./email-handler.js";
import type { Env } from "./env.js";
import { Mailbox } from "./mailbox-do.js";
import { MCP_PRINCIPAL_HEADER } from "./mcp-gateway.js";
import { Memory } from "./memory-do.js";
import { Sandbox, SandboxOutbound, proxyToSandbox } from "./sandbox.js";
import { ContainerProxy } from "./sandbox/npm-shim.js";
import { withVerifiedAccessIdentity } from "./access-jwt.js";
import { handleActivity } from "./activity-routes.js";
import { handleApprovals } from "./approvals-routes.js";
import { handleWorkspaceIntegrations } from "./workspace-integrations-routes.js";
import { handlePersonalExecution } from "./personal-execution-routes.js";
import { handleTeamModelSessions } from "./team-model-routes.js";
import { tickFounderReviewSchedules } from "./founder-review-schedules.js";
import { tickFounderConnectorJobs } from "./founder-connector-jobs.js";
import { handleOnboardingProgress } from "./onboarding-progress.js";
import { handleCollaborationWithRealtime } from "./collaboration-room-routes.js";
import { handleTeamWorkspaces } from "./team-workspaces-routes.js";
import { handleTeamWork } from "./team-work-routes.js";
import { handleEmployeeBundles } from "./employee-bundles-routes.js";
import { enforceTeamMemberApiPolicy } from "./team-member-auth.js";
import { handleReasonNetwork } from "./reason-network/routes.js";
import { handleSubscriptionAuth } from "./auth-routes.js";
import { handleUserOpenAiSubscription } from "./subscription-auth-routes.js";
import { handleAudit } from "./audit-routes.js";
import { handleAutomations } from "./automations-routes.js";
import { handleComputers } from "./computers-routes.js";
import { handleGitHubWebhook } from "./github-webhook-routes.js";
import { handleIntegrationsRoutes } from "./integrations-routes.js";
import { handleIntegrationProviderRoutes } from "./integrations-provider-routes.js";
import { handleLinearWebhook } from "./linear/routes.js";
import { handleGmail } from "./gmail-routes.js";
import { handleSentryWebhook } from "./sentry-webhook-routes.js";
import { handleInbox } from "./inbox-routes.js";
import { handleLocalAdapter, isLocalRuntimePath } from "./local-routes.js";
import { LocalDispatch } from "./local-dispatch.js";
import { handleMcp } from "./mcp-routes.js";
import { handleMemory } from "./memory-routes.js";
import { handleOAuth } from "./oauth-mcp.js";
import { handleAcpProviders } from "./acp-provider-routes.js";
import { handleCapabilityCatalog } from "./capability-catalog-routes.js";
import { pruneCapabilityInvocations } from "./capability-invocations.js";
import { handleApiKeys } from "./api-keys-routes.js";
import { handleCustomAgents } from "./custom-agents-routes.js";
import { handleEmployeeTools } from "./employee-tool-routes.js";
import { handleSkillLibrary } from "./skill-library-routes.js";
import { handleSkills } from "./skills-routes.js";
import { handleSpaces } from "./spaces-routes.js";
import { Spaces } from "./spaces-do.js";
import { handleFounderSkills } from "./founder-skills-routes.js";
import { handleFounderConnectorJobs } from "./founder-connector-routes.js";
import { handleFounderEvidenceReports } from "./founder-evidence-routes.js";
import { handleFounderAutomaticReads } from "./founder-auto-read-routes.js";
import { tickFounderAutomaticReads } from "./founder-auto-read-runtime.js";
import { handleFounderAutomaticReadPermit } from "./founder-auto-read-permits.js";
import { handleFounderAutomaticSlack } from "./founder-automatic-slack-routes.js";
import { tickFounderAutomaticSlack } from "./founder-automatic-slack-tick.js";
import { handleRunOutputArchives } from "./run-output-archive-routes.js";
import { handleSlackInstallations } from "./slack-installations-routes.js";
import { handleMultiInstallationSlackCallback } from "./slack-installations-routing.js";
import { handleSharedComputers } from "./shared-computer-routes.js";
import { ComputerSession } from "./computer-session.js";
import { handleReportSlack } from "./report-slack-routes.js";
import { handleOrgSandboxSettings } from "./org-sandbox-routes.js";
import { handleOrgModelKeys } from "./org-model-keys-routes.js";
import { handleMeta } from "./meta-routes.js";
import { handleRuns } from "./runs-routes.js";
import { handleSwarm } from "./swarm-routes.js";
import { handleDenRoutes } from "./den-routes.js";
import { handleV1 } from "./v1-routes.js";
import { handleUsage } from "./usage-routes.js";
import { handleScreenshot } from "./screenshots-routes.js";
import { handleE2eEvidence } from "./e2e-evidence-routes.js";
import { handleDevOAuthLoopback } from "./dev-oauth-loopback-routes.js";
import { handleWebSessions } from "./sessions-routes.js";
import { handleSlackCanvas } from "./slack-canvas-routes.js";
import { redactSecrets } from "./security.js";
import { handleBetterAuth, isBetterAuthConfigured } from "./better-auth.js";
import { getUserId, isAccessConfigured, isAuthenticated, isAuthorizedRequest, resolveUserId, SIGNATURE_AUTHENTICATED } from "./request-auth.js";
import { handleSlackInteract } from "./slack-approval.js";
import { handleSlackEvents } from "./slack-events.js";
import { handleSlackEvent } from "./slack-mention.js";
import { handleSlackRoomEvent } from "./slack-room-bridge.js";
import { ORCHESTRATOR_NAME, handleSlackCommand } from "./slack-routes.js";
import { handleDiscordInteractions } from "./discord.js";
import { handleTelegramWebhook } from "./telegram.js";
import { handleTrigger } from "./trigger.js";
import { handleSandboxRoutes } from "./sandbox-routes.js";
import { isOrgApiPath, isPublicRequest } from "./public-routes.js";
import { handleWaitlist } from "./waitlist.js";
import { Waitlist } from "./waitlist-do.js";
import { ModelConfig } from "./model-config-do.js";
import { ChatGptAuth } from "./chatgpt-auth-do.js";
import { UserProviderOAuth } from "./user-provider-oauth-do.js";
import { ConversationRoom } from "./conversation-room-do.js";
import {
  isAuthorizedSessionAgent,
  parseSessionAgentName,
  DEFAULT_SESSION_ID,
  WEB_SESSION_PREFIX,
} from "./web-sessions.js";

export {
  ExplorerAgent,
  ReviewerAgent,
  Automations,
  ChatGptAuth,
  ConversationRoom,
  ComputerSession,
  UserProviderOAuth,
  CodingOrchestrator,
  LocalDispatch,
  Mailbox,
  Memory,
  ModelConfig,
  OpenCodeAgent,
  Sandbox,
  SandboxOutbound,
  ContainerProxy,
  Waitlist,
  Spaces,
};
export { assertLiveCodingModel } from "./coding-model.js";
// Kept public for consumers that import the auth surface from the entry.
export { isBetterAuthConfigured } from "./better-auth.js";
export { getUserId, isAuthenticated, isAuthorizedRequest, resolveUserId, SIGNATURE_AUTHENTICATED } from "./request-auth.js";
export { handleWebSessions } from "./sessions-routes.js";

let claudeSubscriptionDeprecationWarned = false;

// The landing site lives on tryshiba.dev; the app host only serves the dashboard.
const MARKETING_SECTIONS = new Set([
  "docs",
  "blog",
  "why-shiba",
  "privacy",
  "terms",
  "waitlist",
  "welcome",
]);
// Root paths of the dashboard's sidebar views (AppNavRail ids); "" is the Work home.
export const DASHBOARD_VIEWS = new Set([
  "slack-canvas",
  // Keep in sync with AppNavRail APP_NAV_ITEMS ids.
  "",
  "work",
  "dashboard",
  "tasks",
  "threads",
  "activity",
  "analytics",
  "diff",
  "approvals",
  "swarm",
  "collaboration",
  "team",
  "agents",
  "inbox",
  "memory",
  "automations",
  "providers",
  "employee-tools",
  "integrations",
  "skills",
  "spaces",
  "custom-agents",
  "remote",
  "settings",
]);

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try { await tickFounderAutomaticReads(env); }
      catch (error) { console.error("Founder automatic read scheduling failed", redactSecrets(String(error))); }
      try { await tickFounderAutomaticSlack(env); }
      catch (error) { console.error("Founder automatic Slack scheduling failed", redactSecrets(String(error))); }
    })());
    ctx.waitUntil(tickFounderReviewSchedules(env).catch((error: unknown) => {
      console.error("Founder review scheduling failed", redactSecrets(String(error)));
    }));
    ctx.waitUntil(tickFounderConnectorJobs(env).catch((error: unknown) => {
      console.error("Founder connector scheduling failed", redactSecrets(String(error)));
    }));
    ctx.waitUntil(
      automationsStub(env)
        .fetch(new Request("https://internal/internal/tick", { method: "POST" }))
        .then((response) => {
          if (!response.ok) {
            console.error(`automation tick failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
    // Stale-draft sweep: the approvals-poll and restart paths only run it
    // when a human is watching — the cron is the backstop that frees a
    // `sending`-locked draft in an idle system (review finding). Same
    // shared "default" instance the email-kind mints pin to.
    ctx.waitUntil(
      getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME)
        .then((stub) =>
          stub.fetch(new Request("https://internal/internal/sweep-drafts", { method: "POST" })),
        )
        .then((response) => {
          if (!response.ok) {
            console.error(`stale draft sweep failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
    // Retention: audit_log keeps 90 days — pruned here on the same cron
    // that ticks automations (megaplan T13). Best-effort like the writer:
    // a D1 hiccup warns and retries on the next tick, never blocks it.
    if (env.AGENT_AUDIT !== undefined) {
      ctx.waitUntil(
        Promise.all([
          pruneAuditLog(env, Date.now() - AUDIT_RETENTION_MS),
          pruneCapabilityInvocations(env, Date.now() - AUDIT_RETENTION_MS),
        ]).then(([auditDeleted, invocationDeleted]) => {
            if (auditDeleted > 0) console.log(`audit prune deleted ${auditDeleted} row(s) older than 90 days`);
            if (invocationDeleted > 0) console.log(`capability invocation prune deleted ${invocationDeleted} row(s) older than 90 days`);
          })
          .catch((error: unknown) => {
            console.warn(
              `audit prune failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            );
          }),
      );
    }
  },
  // Email Routing delivery — registered-mailbox gate + store, see email-handler.ts.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      // A one-purpose Worker capability, verified before any identity or D1 lookup.
      // No dashboard, model or Durable Object execution authority is inherited.
      if (new URL(request.url).pathname === "/internal/founder-automatic-read/permit") {
        const permit = await handleFounderAutomaticReadPermit(request, env);
        if (permit) return permit;
      }
      if (!claudeSubscriptionDeprecationWarned && env.SHIBA_CLAUDE_SUBSCRIPTION === "1") {
        claudeSubscriptionDeprecationWarned = true;
        console.warn(
          "SHIBA_CLAUDE_SUBSCRIPTION is enabled: the claude-subscription harness stores Claude.ai tokens at the Worker egress boundary, which may violate Anthropic's terms — prefer claude-login (https://code.claude.com/docs/en/legal-and-compliance).",
        );
      }
      request = await withVerifiedAccessIdentity(request, env);
      // MCP_PRINCIPAL_HEADER is minted only by the verified-bearer path in
      // handleMcp — no external caller may set it. Strip at ingress so a
      // future route cannot accidentally trust a client-supplied copy.
      if (request.headers.has(MCP_PRINCIPAL_HEADER)) {
        const headers = new Headers(request.headers);
        headers.delete(MCP_PRINCIPAL_HEADER);
        request = new Request(request, { headers });
      }
      const url = new URL(request.url);
      const artifactDownload = await handleArtifactDownload(request, env);
      if (artifactDownload) return artifactDownload;
      // Order: the better-auth lane owns `/api/auth/*` (minus the
      // subscription-connect paths it shares that prefix with — those stay
      // gated below), so it is served before the identity gate sees the
      // request. The gate then composes both identity systems.
      const betterAuthResponse = await handleBetterAuth(request, env, { teamMemberPolicyEnabled: true });
      if (betterAuthResponse) return betterAuthResponse;
      if (url.pathname === "/api/slack/installations/callback") {
        const callback = await handleSlackInstallations(request, env);
        if (callback) return callback;
      }
      const devOAuthLoopbackResponse = await handleDevOAuthLoopback(request, env);
      if (devOAuthLoopbackResponse) {
        return devOAuthLoopbackResponse;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const section = url.pathname.split("/")[1] ?? "";
        if (MARKETING_SECTIONS.has(section)) {
          return Response.redirect(`https://tryshiba.dev${url.pathname}${url.search}`, 301);
        }
        // The shell is static and shows sign-in itself; single segment so /agents/<do>/… still routes.
        if (DASHBOARD_VIEWS.has(section) && /^\/[^/]*\/?$/.test(url.pathname)) {
          return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
        }
        if (/^\/spaces\/[^/]+\/?$/.test(url.pathname)) {
          return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
        }
      }
      if (!isPublicRequest(request) && !isOrgApiPath(url.pathname) && !(await isAuthorizedRequest(request, env))) {
        // A signed-out browser on the consent screen goes to sign-in and
        // comes back; MCP clients and fetch() keep the JSON 401.
        if (
          request.method === "GET" &&
          url.pathname === "/oauth/authorize" &&
          (request.headers.get("Accept") ?? "").includes("text/html")
        ) {
          const next = encodeURIComponent(`${url.pathname}${url.search}`);
          return Response.redirect(new URL(`/?next=${next}`, url).toString(), 302);
        }
        return Response.json(
          {
            error: "Authentication required.",
            // better_auth wins even with Access on, so the dashboard still offers email sign-in.
            ...(isBetterAuthConfigured(env)
              ? { code: "better_auth" }
              : !isAccessConfigured(env)
                ? { code: "access_not_configured" }
                : {}),
          },
          { status: 401 },
        );
      }
      const memberPolicyResponse = await enforceTeamMemberApiPolicy(request, env);
      if (memberPolicyResponse) return memberPolicyResponse;
      const outputArchiveResponse = await handleRunOutputArchives(request, env);
      if (outputArchiveResponse) return outputArchiveResponse;
      const slackInstallationResponse = await handleSlackInstallations(request, env);
      if (slackInstallationResponse) return slackInstallationResponse;
      const sharedComputerResponse = await handleSharedComputers(request, env);
      if (sharedComputerResponse) return sharedComputerResponse;
      const workspaceIntegrationResponse = await handleWorkspaceIntegrations(request, env);
      if (workspaceIntegrationResponse) return workspaceIntegrationResponse;
      const personalExecutionResponse = await handlePersonalExecution(request, env);
      if (personalExecutionResponse) return personalExecutionResponse;
      const teamModelResponse = await handleTeamModelSessions(request, env);
      if (teamModelResponse) return teamModelResponse;
      const workResponse = await handleTeamWork(request, env);
      if (workResponse) return workResponse;
      const workspaceResponse = await handleTeamWorkspaces(request, env);
      if (workspaceResponse) return workspaceResponse;
      const bundleResponse = await handleEmployeeBundles(request, env);
      if (bundleResponse) return bundleResponse;
      const gmailResponse = await handleGmail(request, env);
      if (gmailResponse) return gmailResponse;
      const oauthResponse = await handleOAuth(request, env, await resolveUserId(request, env));
      if (oauthResponse) return oauthResponse;
      const waitlistResponse = await handleWaitlist(request, env);
      if (waitlistResponse) return waitlistResponse;
      if (SIGNATURE_AUTHENTICATED.includes(url.pathname) && request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      const metaResponse = await handleMeta(request, env);
      if (metaResponse) return metaResponse;
      const onboardingResponse = await handleOnboardingProgress(request, env);
      if (onboardingResponse) return onboardingResponse;
      const acpProviderResponse = await handleAcpProviders(request, env);
      if (acpProviderResponse) return acpProviderResponse;
      const capabilityCatalogResponse = await handleCapabilityCatalog(request, env);
      if (capabilityCatalogResponse) return capabilityCatalogResponse;
      const apiKeysResponse = await handleApiKeys(request, env);
      if (apiKeysResponse) return apiKeysResponse;
      const customAgentsResponse = await handleCustomAgents(request, env);
      if (customAgentsResponse) return customAgentsResponse;
      const employeeToolsResponse = await handleEmployeeTools(request, env);
      if (employeeToolsResponse) return employeeToolsResponse;
      const reasonNetworkResponse = await handleReasonNetwork(request, env);
      if (reasonNetworkResponse) return reasonNetworkResponse;
      const skillLibraryResponse = await handleSkillLibrary(request, env);
      if (skillLibraryResponse) return skillLibraryResponse;
      const skillsResponse = await handleSkills(request, env);
      if (skillsResponse) return skillsResponse;
      const spacesResponse = await handleSpaces(request, env);
      if (spacesResponse) return spacesResponse;
      const founderConnectorResponse = await handleFounderConnectorJobs(request, env);
      if (founderConnectorResponse) return founderConnectorResponse;
      const reportSlackResponse = await handleReportSlack(request, env);
      if (reportSlackResponse) return reportSlackResponse;
      const founderAutomaticResponse = await handleFounderAutomaticReads(request, env);
      if (founderAutomaticResponse) return founderAutomaticResponse;
      const founderAutomaticSlackResponse = await handleFounderAutomaticSlack(request, env);
      if (founderAutomaticSlackResponse) return founderAutomaticSlackResponse;
      const founderEvidenceResponse = await handleFounderEvidenceReports(request, env);
      if (founderEvidenceResponse) return founderEvidenceResponse;
      const founderSkillsResponse = await handleFounderSkills(request, env);
      if (founderSkillsResponse) return founderSkillsResponse;
      const orgSandboxResponse = await handleOrgSandboxSettings(request, env);
      if (orgSandboxResponse) return orgSandboxResponse;
      const orgModelKeysResponse = await handleOrgModelKeys(request, env);
      if (orgModelKeysResponse) return orgModelKeysResponse;
      const userOpenAiSubscriptionResponse = await handleUserOpenAiSubscription(request, env);
      if (userOpenAiSubscriptionResponse) return userOpenAiSubscriptionResponse;
      const subscriptionAuthResponse = await handleSubscriptionAuth(request, env);
      if (subscriptionAuthResponse) {
        return subscriptionAuthResponse;
      }
      const mcpResponse = await handleMcp(
        request,
        env,
        ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext),
      );
      if (mcpResponse) {
        return mcpResponse;
      }
      // T51: self-authenticated daemon surface — flag + bearer inside.
      if (isLocalRuntimePath(url.pathname)) {
        return handleLocalAdapter(request, env);
      }
      // `/internal/*` paths exist only inside DO stub fetches (Automations
      // tick/dedupe, the Mailbox JSON API under `/internal/mailbox/`) — the
      // worker never serves them to the outside.
      if (url.pathname.startsWith("/internal/")) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      const approvalsResponse = await handleApprovals(request, env);
      if (approvalsResponse) {
        return approvalsResponse;
      }
      const collaborationResponse = await handleCollaborationWithRealtime(request, env);
      if (collaborationResponse) return collaborationResponse;
      const computersResponse = await handleComputers(request, env);
      if (computersResponse) {
        return computersResponse;
      }
      ensureLiveCodingModel(env);
      const sandboxResponse = await proxyToSandbox(request, env);
      if (sandboxResponse) {
        return sandboxResponse;
      }
      const denResponse = await handleDenRoutes(request, env);
      if (denResponse) {
        return denResponse;
      }
      const slackCanvasResponse = await handleSlackCanvas(request, env);
      if (slackCanvasResponse) return slackCanvasResponse;
      const runsResponse = await handleRuns(request, env);
      if (runsResponse) {
        return runsResponse;
      }
      const swarmResponse = await handleSwarm(request, env);
      if (swarmResponse) {
        return swarmResponse;
      }
      const v1Response = await handleV1(request, env);
      if (v1Response) return v1Response;
      const usageResponse = await handleUsage(request, env);
      if (usageResponse) {
        return usageResponse;
      }
      const activityResponse = await handleActivity(request, env);
      if (activityResponse) {
        return activityResponse;
      }
      const screenshotResponse = await handleScreenshot(request, env);
      if (screenshotResponse) {
        return screenshotResponse;
      }
      const e2eEvidenceResponse = await handleE2eEvidence(request, env);
      if (e2eEvidenceResponse) {
        return e2eEvidenceResponse;
      }
      const webSessionsResponse = await handleWebSessions(request, env);
      if (webSessionsResponse) {
        return webSessionsResponse;
      }
      const inboxResponse = await handleInbox(request, env);
      if (inboxResponse) {
        return inboxResponse;
      }
      const memoryResponse = await handleMemory(request, env);
      if (memoryResponse) {
        return memoryResponse;
      }
      const auditResponse = await handleAudit(request, env);
      if (auditResponse) {
        return auditResponse;
      }
      const sandboxRouteResponse = await handleSandboxRoutes(request, env);
      if (sandboxRouteResponse) {
        return sandboxRouteResponse;
      }
      const chatCtx = ctx ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) } : undefined;
      const telegramResponse = await handleTelegramWebhook(request, env, chatCtx, {
        dedupe: (updateId) => seenDelivery(env, `telegram-update:${updateId}`),
      });
      if (telegramResponse) {
        return telegramResponse;
      }
      const discordResponse = await handleDiscordInteractions(request, env, chatCtx);
      if (discordResponse) {
        return discordResponse;
      }
      const managedSlackResponse = await handleMultiInstallationSlackCallback(request, env);
      if (managedSlackResponse) return managedSlackResponse;
      const slackEventsResponse = await handleSlackEvents(
        request,
        env,
        ctx ?? { waitUntil: () => {} } as unknown as ExecutionContext,
        {
          dedupe: (eventId) => seenDelivery(env, `slack-event:${eventId}`),
          onEvent: async (body, eventEnv) => {
            await handleSlackRoomEvent(body, eventEnv);
            await handleSlackEvent(body, eventEnv);
            try {
              const response = await automationsStub(eventEnv).fetch(
                new Request("https://internal/internal/slack", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }),
              );
              if (!response.ok) {
                console.error(`automation slack fan-out failed: ${response.status}`);
              }
            } catch (error: unknown) {
              console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
            }
          },
        },
      );
      if (slackEventsResponse) {
        return slackEventsResponse;
      }
      const slackResponse = await handleSlackCommand(request, env, {}, ctx);
      if (slackResponse) {
        return slackResponse;
      }
      const triggerResponse = await handleTrigger(request, env);
      if (triggerResponse) {
        return triggerResponse;
      }
      // Pointer.threadKey names the DO that queued the card (slash = default).
      const slackInteractResponse = await handleSlackInteract(request, env, {
        resolveOrchestrator: (threadKey) => getAgentByName(env.CodingOrchestrator, threadKey || ORCHESTRATOR_NAME),
      }, ctx ? { waitUntil: (promise) => ctx.waitUntil(promise) } : undefined);
      if (slackInteractResponse) {
        return slackInteractResponse;
      }
      const automationsResponse = await handleAutomations(request, env);
      if (automationsResponse) {
        return automationsResponse;
      }
      const webhookResponse = await handleGitHubWebhook(request, env, ctx);
      if (webhookResponse) {
        return webhookResponse;
      }
      const linearWebhookResponse = await handleLinearWebhook(request, env, ctx);
      if (linearWebhookResponse) {
        return linearWebhookResponse;
      }
      const integrationsResponse = await handleIntegrationsRoutes(request, env);
      if (integrationsResponse) {
        return integrationsResponse;
      }
      const integrationProviderResponse = await handleIntegrationProviderRoutes(request, env);
      if (integrationProviderResponse) {
        return integrationProviderResponse;
      }
      const sentryResponse = await handleSentryWebhook(request, env);
      if (sentryResponse) {
        return sentryResponse;
      }
      if (url.pathname.startsWith("/agents/")) {
        const route = url.pathname.match(/^\/agents\/coding-orchestrator\/([^/]+)(?:\/(.*))?$/);
        if (!route) return Response.json({ error: "Not found." }, { status: 404 });
        let name: string;
        try {
          name = decodeURIComponent(route[1]!);
        } catch {
          return Response.json({ error: "Invalid agent name." }, { status: 400 });
        }
        const currentUserId = (await resolveUserId(request, env)) ?? "default";
        if (!isAuthorizedSessionAgent(name, currentUserId)) {
          return Response.json({ error: "Forbidden." }, { status: 403 });
        }
        // All child work uses trusted parent RPC. Unknown or malformed child
        // paths must not fall back to an ordinary parent chat transport.
        try {
          if (decodeURIComponent(route[2] ?? "").split("/").includes("sub")) {
            return Response.json({ error: "Not found." }, { status: 404 });
          }
        } catch {
          return Response.json({ error: "Invalid agent path." }, { status: 400 });
        }
        if (name.startsWith(WEB_SESSION_PREFIX)) {
          const parsed = parseSessionAgentName(name);
          if (parsed && parsed.sessionId !== DEFAULT_SESSION_ID) {
            const userStub = await getAgentByName(env.CodingOrchestrator, currentUserId);
            const checkRes = await userStub.fetch(
              `https://internal/internal/web-sessions/${encodeURIComponent(parsed.sessionId)}`,
            );
            if (checkRes.status === 404) {
              return Response.json({ error: "Session not found." }, { status: 404 });
            }
            if (!checkRes.ok) {
              return Response.json({ error: "Failed to verify session." }, { status: checkRes.status });
            }
            const checked = await checkRes.json().catch(() => null) as {
              session?: { id?: unknown; userId?: unknown; metadata?: Record<string, unknown> };
            } | null;
            if (!checked?.session || checked.session.id !== parsed.sessionId || checked.session.userId !== currentUserId) {
              return Response.json({ error: "Session not found." }, { status: 404 });
            }
            const metadata = checked.session.metadata;
            // Private team-session chat has no proven workspace-aware runtime.
            // An owner name or current operator login cannot replace its room
            // and source authority, including after workspace removal.
            if ((typeof metadata?.orgId === "string" && metadata.orgId.startsWith("team:")) ||
                (metadata && (Object.hasOwn(metadata, "teamWorkspaceId") || Object.hasOwn(metadata, "teamMembershipVersion")))) {
              return Response.json({ error: "Use the shared room for team employee work." }, { status: 403 });
            }
          }
        }
        // Slack queue and approval routes are reachable only through verified callbacks.
        if (route[2]?.startsWith("api/") || route[2]?.startsWith("internal/")) {
          return Response.json({ error: "Not found." }, { status: 404 });
        }
        const suffix = route[2];
        const canonicalAgentPath = `/agents/coding-orchestrator/${encodeURIComponent(name)}${
          suffix ? `/${suffix}` : ""
        }`;
        const agentRequest =
          canonicalAgentPath === url.pathname
            ? request
            : new Request(new URL(`${canonicalAgentPath}${url.search}`, url.origin), request);
        const agent = await getAgentByName(env.CodingOrchestrator, name);
        return agent.fetch(agentRequest);
      }
      const agentResponse = await routeAgentRequest(request, {
        CodingOrchestrator: env.CodingOrchestrator,
      });
      if (agentResponse) {
        return agentResponse;
      }
      // An `/api/*` URL that survived every handler is an API miss, not a
      // page route — answer JSON instead of the marketing 404 HTML.
      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      // The client gets a generic 500; the redacted detail stays in the log.
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
      return Response.json({ error: "Internal error." }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
