import { getAgentByName, routeAgentRequest } from "agents/routing";
import { handleArtifactDownload } from "../artifact-download.js";
import { automationsStub, seenDelivery } from "../automations-stub.js";
import { proxyToSandbox } from "../sandbox.js";
import { handleActivity } from "../activity-routes.js";
import { handleApprovals } from "../approvals-routes.js";
import { handleWorkspaceIntegrations } from "../workspace-integrations-routes.js";
import { handlePersonalExecution } from "../personal-execution-routes.js";
import { handleOnboardingProgress } from "../onboarding-progress.js";
import { handleTeamWorkspaces } from "../team-workspaces-routes.js";
import { handlePrimaryBot } from "../collaboration-primary-bot-routes.js";
import { handleTeamWork } from "../team-work-routes.js";
import { handleEmployeeBundles } from "../employee-bundles-routes.js";
import { handleReasonNetwork } from "../reason-network/routes.js";
import { handleSubscriptionAuth } from "../auth-routes.js";
import { handleUserOpenAiSubscription } from "../subscription-auth-routes.js";
import { handleAudit } from "../audit-routes.js";
import { handleGovernance } from "../governance-routes.js";
import { handleShare } from "../share-routes.js";
import { handleAutomations } from "../automations-routes.js";
import { handleComputers } from "../computers-routes.js";
import { handleGitHubWebhook } from "../github-webhook-routes.js";
import { handleIntegrationsRoutes } from "../integrations-routes.js";
import { handleLinearWebhook } from "../linear/routes.js";
import { handleGmail } from "../gmail-routes.js";
import { handleSentryWebhook } from "../sentry-webhook-routes.js";
import { handleInbox } from "../inbox-routes.js";
import { handleLocalAdapter, isLocalRuntimePath } from "../local-routes.js";
import { handleMemory } from "../memory-routes.js";
import { handleFiles } from "../files/files-routes.js";
import { handleNotes } from "../notes/notes-routes.js";
import { handleKnowledge } from "../knowledge/knowledge-routes.js";
import { handleKnowledgeOutputs } from "../knowledge/knowledge-outputs-routes.js";
import { handleKnowledgeProjects } from "../knowledge/knowledge-projects-routes.js";
import { handleOAuth } from "../oauth-mcp.js";
import { handleCapabilityCatalog } from "../capability-catalog-routes.js";
import { handleApiKeys } from "../api-keys-routes.js";
import { handleOutboundWebhooks } from "../webhooks/routes.js";
import { handleCustomAgents } from "../custom-agents-routes.js";
import { handleEmployeeTools } from "../employee-tool-routes.js";
import { handleSkills } from "../skills-routes.js";
import { handleSpaces } from "../spaces-routes.js";
import { handleRunOutputArchives } from "../run-output-archive-routes.js";
import { handleSlackInstallations } from "../slack-installations-routes.js";
import { handleMultiInstallationSlackCallback } from "../slack-installations-routing.js";
import { handleSharedComputers } from "../shared-computer-routes.js";
import { handleOrgSandboxSettings } from "../org-sandbox-routes.js";
import { handleOrgModelKeys } from "../org-model-keys-routes.js";
import { handleMeta } from "../meta-routes.js";
import { handleRuns } from "../runs-routes.js";
import { handleSwarm } from "../swarm-routes.js";
import { handleDenRoutes } from "../den-routes.js";
import { handleUsage } from "../usage-routes.js";
import { handleVoiceRoutes } from "../voice-routes.js";
import { handleScreenshot } from "../screenshots-routes.js";
import { handleE2eEvidence } from "../e2e-evidence-routes.js";
import { handleDevOAuthLoopback } from "../dev-oauth-loopback-routes.js";
import { handleWebSessions } from "../sessions-routes.js";
import { handleSlackCanvas } from "../slack-canvas-routes.js";
import { redactSecrets } from "../security.js";
import { handleBetterAuth } from "../better-auth.js";
import { handleEmailDeliveryRoutes } from "../email/routes.js";
import { SIGNATURE_AUTHENTICATED } from "../request-auth.js";
import { handleSlackInteract } from "../slack-approval.js";
import { handleSlackEvents } from "../slack-events.js";
import { handleSlackEvent } from "../slack-mention.js";
import { handleSlackRoomEvent } from "../slack-room-bridge.js";
import { ORCHESTRATOR_NAME, handleSlackCommand } from "../slack-routes.js";
import { handleDiscordInteractions } from "../discord.js";
import { handleTelegramWebhook } from "../telegram.js";
import { handleTeamsMessages } from "../teams.js";
import { handleTrigger } from "../trigger.js";
import { handleSandboxRoutes } from "../sandbox-routes.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { isOrgApiPath } from "../public-routes.js";
import { handleWaitlist } from "../waitlist.js";
import {
  isAuthorizedSessionAgent,
  parseSessionAgentName,
  DEFAULT_SESSION_ID,
  WEB_SESSION_PREFIX,
} from "../web-sessions.js";

import { isDashboardViewPath, isMarketingSection } from "../app-host-routing.js";
import type { RequestContext } from "./context.js";

// Thin adapters preserve the original checks, return-null behavior and lazy module boundaries.
export const handlers = {
  async observabilityResponse(context: RequestContext): Promise<Response | null> {
    return (await import("../observability-routes.js")).handleObservability(context.request, context.env, context.execution);
  },
  async permit(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    if (new URL(request.url).pathname === "/internal/founder-automatic-read/permit") {
      const permit = await (
        await import("../founder-auto-read-permits.js")
      ).handleFounderAutomaticReadPermit(request, env);
      if (permit) return permit;
    }
    return null;
  },
  async artifactDownload(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    const artifactDownload = await handleArtifactDownload(request, env);
    if (artifactDownload) return artifactDownload;
    // Order: the better-auth lane owns `/api/auth/*` (minus the
    // subscription-connect paths it shares that prefix with — those stay
    // gated below), so it is served before the identity gate sees the
    // request. The gate then composes both identity systems.
    return null;
  },
  async betterAuthResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleBetterAuth(request, env, { teamMemberPolicyEnabled: true });
  },
  async callback(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (url.pathname === "/api/slack/installations/callback") {
      const callback = await handleSlackInstallations(request, env);
      if (callback) return callback;
    }
    return null;
  },
  async devOAuthLoopbackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleDevOAuthLoopback(request, env);
  },
  async shell(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (request.method === "GET" || request.method === "HEAD") {
      const section = url.pathname.split("/")[1] ?? "";
      if (isMarketingSection(section)) {
        return Response.redirect(`https://tryshiba.dev${url.pathname}${url.search}`, 301);
      }
      // The shell is static and shows sign-in itself; single segment so /agents/<do>/… still routes.
      if (isDashboardViewPath(section, url.pathname)) {
        return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
      }
      // WS02: password reset surfaces share the dashboard shell.
      if (/^\/auth\/(?:forgot|reset)\/?$/.test(url.pathname)) {
        return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
      }
      if (/^\/spaces\/[^/]+\/?$/.test(url.pathname)) {
        return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
      }
      if (/^\/share\/[cf]\/[^/]+\/?$/.test(url.pathname)) {
        return env.ASSETS.fetch(new Request(new URL("/app/", url), request));
      }
    }
    return null;
  },
  async publicShareResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleShare(request, env);
  },
  async outputArchiveResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleRunOutputArchives(request, env);
  },
  async slackInstallationResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSlackInstallations(request, env);
  },
  async slackCoworkerResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../slack-coworker-routes.js")).handleSlackCoworker(request, env);
  },
  async sharedComputerResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSharedComputers(request, env);
  },
  async workspaceIntegrationResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleWorkspaceIntegrations(request, env);
  },
  async personalExecutionResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handlePersonalExecution(request, env);
  },
  async employeeAccessResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../governance/employee-access-routes.js")).handleEmployeeAccess(request, env);
  },
  async learningResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../learning-routes.js")).handleLearning(request, env);
  },
  async uiBlockResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../ui-block-routes.js")).handleUiBlocks(request, env);
  },
  async teamModelResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../team-model-routes.js")).handleTeamModelSessions(request, env);
  },
  async workResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleTeamWork(request, env);
  },
  async primaryBotResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handlePrimaryBot(request, env);
  },
  async searchResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../search-routes.js")).handleSearch(request, env);
  },
  async paletteResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../palette-routes.js")).handlePalette(request, env);
  },
  async askUserResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../ask-user-routes.js")).handleAskUser(request, env);
  },
  async workspaceResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleTeamWorkspaces(request, env);
  },
  async governanceResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleGovernance(request, env);
  },
  async shareResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    const shareResponse = await handleShare(request, env);
    if (shareResponse) return shareResponse;
    // WS02: operator email delivery status (no message bodies).
    return null;
  },
  async emailDeliveryResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleEmailDeliveryRoutes(request, env);
  },
  async seedResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../first-run-seed.js")).handleFirstRunSeed(request, env);
  },
  async bundleResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleEmployeeBundles(request, env);
  },
  async gmailResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleGmail(request, env);
  },
  async oauthResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleOAuth(request, env, await context.identity());
  },
  async waitlistResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleWaitlist(request, env);
  },
  async callbackMethod(context: RequestContext): Promise<Response | null> {
    const { request, url } = context;
    if (SIGNATURE_AUTHENTICATED.includes(url.pathname) && request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    return null;
  },
  async metaResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleMeta(request, env);
  },
  async workspaceEventsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../platform/workspace-events-routes.js")).handleWorkspaceEvents(
      request,
      env,
    );
  },
  async teamOnboardingTask(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../team-onboarding-task.js")).handleTeamOnboardingTask(request, env);
  },
  async onboardingResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleOnboardingProgress(request, env);
  },
  async acpProviderResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    return url.pathname === "/api/providers" || url.pathname.startsWith("/api/providers/")
      ? (await import("../acp-provider-routes.js")).handleAcpProviders(request, env)
      : null;
  },
  async capabilityCatalogResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleCapabilityCatalog(request, env);
  },
  async apiKeysResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleApiKeys(request, env);
  },
  async outboundWebhooksResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleOutboundWebhooks(request, env);
  },
  async customAgentsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleCustomAgents(request, env);
  },
  async employeeToolsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleEmployeeTools(request, env);
  },
  async reasonNetworkResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleReasonNetwork(request, env);
  },
  async skillLibraryResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../skill-library-routes.js")).handleSkillLibrary(request, env);
  },
  async skillsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSkills(request, env);
  },
  async spacesResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSpaces(request, env);
  },
  async founderConnectorResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-connector-routes.js")).handleFounderConnectorJobs(
      request,
      env,
    );
  },
  async reportSlackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../report-slack-routes.js")).handleReportSlack(request, env);
  },
  async founderAutomaticResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-auto-read-routes.js")).handleFounderAutomaticReads(
      request,
      env,
    );
  },
  async founderStripeResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-stripe-routes.js")).handleFounderStripeReads(request, env);
  },
  async founderMetaResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-meta-routes.js")).handleFounderMetaReads(request, env);
  },
  async founderHubSpotResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-hubspot-routes.js")).handleFounderHubSpotReads(request, env);
  },
  async reconciliationResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-reconciliation-routes.js")).handleFounderReconciliations(
      request,
      env,
    );
  },
  async standingComparisonResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (
      await import("../founder-reconciliation-schedule-routes.js")
    ).handleFounderReconciliationSchedules(request, env);
  },
  async reconciliationSlackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (
      await import("../founder-reconciliation-slack-routes.js")
    ).handleFounderReconciliationSlack(request, env);
  },
  async stripeSlackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (
      await import("../founder-automatic-slack-stripe-routes.js")
    ).handleFounderStripeAutomaticSlack(request, env);
  },
  async founderAutomaticSlackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-automatic-slack-routes.js")).handleFounderAutomaticSlack(
      request,
      env,
    );
  },
  async founderEvidenceResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-evidence-routes.js")).handleFounderEvidenceReports(
      request,
      env,
    );
  },
  async founderSkillsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../founder-skills-routes.js")).handleFounderSkills(request, env);
  },
  async orgSandboxResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleOrgSandboxSettings(request, env);
  },
  async orgModelKeysResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleOrgModelKeys(request, env);
  },
  async userOpenAiSubscriptionResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleUserOpenAiSubscription(request, env);
  },
  async subscriptionAuthResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSubscriptionAuth(request, env);
  },
  async mcpResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    const mcpResponse = await (await import("../mcp-routes.js")).handleMcp(
      request,
      env,
      ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext),
    );
    if (mcpResponse) {
      return mcpResponse;
    }
    // T51: self-authenticated daemon surface — flag + bearer inside.
    return null;
  },
  async local(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (isLocalRuntimePath(url.pathname)) {
      return handleLocalAdapter(request, env);
    }
    // `/internal/*` paths exist only inside DO stub fetches (Automations
    // tick/dedupe, the Mailbox JSON API under `/internal/mailbox/`) — the
    // worker never serves them to the outside.
    return null;
  },
  async internal(context: RequestContext): Promise<Response | null> {
    const { url } = context;
    if (url.pathname.startsWith("/internal/")) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return null;
  },
  async approvalsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleApprovals(request, env);
  },
  async collaborationResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../collaboration-room-routes.js")).handleCollaborationWithRealtime(
      request,
      env,
    );
  },
  async notificationsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../notifications/notifications-routes.js")).handleNotifications(
      request,
      env,
    );
  },
  async slackImportResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../slack-import/routes.js")).handleSlackImport(request, env);
  },
  async computersResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleComputers(request, env);
  },
  async sandboxResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return proxyToSandbox(request, env);
  },
  async denResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleDenRoutes(request, env);
  },
  async slackCanvasResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSlackCanvas(request, env);
  },
  async runsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleRuns(request, env);
  },
  async swarmResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSwarm(request, env);
  },
  async v1Response(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return (await import("../v1-routes.js")).handleV1(request, env);
  },
  async usageResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleUsage(request, env);
  },
  async voiceResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleVoiceRoutes(request, env);
  },
  async activityResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleActivity(request, env);
  },
  async screenshotResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleScreenshot(request, env);
  },
  async e2eEvidenceResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleE2eEvidence(request, env);
  },
  async webSessionsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleWebSessions(request, env);
  },
  async inboxResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleInbox(request, env);
  },
  async memoryResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleMemory(request, env);
  },
  async filesResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleFiles(request, env);
  },
  async notesResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleNotes(request, env);
  },
  async knowledgeResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleKnowledge(request, env);
  },
  async projectsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleKnowledgeProjects(request, env);
  },
  async outputsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleKnowledgeOutputs(request, env);
  },
  async auditResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleAudit(request, env);
  },
  async sandboxRouteResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSandboxRoutes(request, env);
  },
  async telegramResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    const chatCtx = ctx
      ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) }
      : undefined;
    return handleTelegramWebhook(request, env, chatCtx, {
      dedupe: (updateId) => seenDelivery(env, `telegram-update:${updateId}`),
    });
  },
  async discordResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    const chatCtx = ctx
      ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) }
      : undefined;
    return handleDiscordInteractions(request, env, chatCtx);
  },
  async teamsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    const chatCtx = ctx
      ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) }
      : undefined;
    return handleTeamsMessages(request, env, chatCtx, {
      dedupe: (activityId) => seenDelivery(env, `teams-activity:${activityId}`),
    });
  },
  async managedSlackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution } = context;
    return handleMultiInstallationSlackCallback(request, env, execution);
  },
  async slackEventsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    return handleSlackEvents(
      request,
      env,
      ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext),
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
  },
  async slackResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    return handleSlackCommand(request, env, {}, ctx);
  },
  async triggerResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    const triggerResponse = await handleTrigger(request, env);
    if (triggerResponse) {
      return triggerResponse;
    }
    // Pointer.threadKey names the DO that queued the card (slash = default).
    return null;
  },
  async slackInteractResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    return handleSlackInteract(
      request,
      env,
      {
        resolveOrchestrator: (threadKey) =>
          getAgentByName(env.CodingOrchestrator, threadKey || ORCHESTRATOR_NAME),
      },
      ctx ? { waitUntil: (promise) => ctx.waitUntil(promise) } : undefined,
    );
  },
  async automationsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleAutomations(request, env);
  },
  async webhookResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    return handleGitHubWebhook(request, env, ctx);
  },
  async linearWebhookResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, execution: ctx } = context;
    return handleLinearWebhook(request, env, ctx);
  },
  async integrationsResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleIntegrationsRoutes(request, env);
  },
  async enrollment(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (
      url.pathname === "/api/operator-enrollment-reviews" ||
      url.pathname.startsWith("/api/operator-enrollment-reviews/")
    ) {
      const { handleOperatorEnrollmentReviews } = await import("../operator-enrollment-routes.js");
      const response = await handleOperatorEnrollmentReviews(request, env);
      if (response) return response;
    }
    return null;
  },
  async integrationProviderResponse(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    return url.pathname === "/api/integrations/provider" || url.pathname.startsWith("/api/integrations/provider/")
      ? (await import("../integrations-provider-routes.js")).handleIntegrationProviderRoutes(request, env)
      : null;
  },
  async sentryResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return handleSentryWebhook(request, env);
  },
  async agents(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (url.pathname.startsWith("/agents/")) {
      const route = url.pathname.match(/^\/agents\/coding-orchestrator\/([^/]+)(?:\/(.*))?$/);
      if (!route) return Response.json({ error: "Not found." }, { status: 404 });
      let name: string;
      try {
        name = decodeURIComponent(route[1]!);
      } catch {
        return Response.json({ error: "Invalid agent name." }, { status: 400 });
      }
      const currentUserId = (await context.identity()) ?? "default";
      if (!isAuthorizedSessionAgent(name, currentUserId)) {
        return Response.json({ error: "Forbidden." }, { status: 403 });
      }
      // All child work uses trusted parent RPC. Unknown or malformed child
      // paths must not fall back to an ordinary parent chat transport.
      try {
        if (
          decodeURIComponent(route[2] ?? "")
            .split("/")
            .includes("sub")
        ) {
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
            return Response.json(
              { error: "Failed to verify session." },
              { status: checkRes.status },
            );
          }
          const checked = (await checkRes.json().catch(() => null)) as {
            session?: { id?: unknown; userId?: unknown; metadata?: Record<string, unknown> };
          } | null;
          if (
            !checked?.session ||
            checked.session.id !== parsed.sessionId ||
            checked.session.userId !== currentUserId
          ) {
            return Response.json({ error: "Session not found." }, { status: 404 });
          }
          const metadata = checked.session.metadata;
          // Private team-session chat has no proven workspace-aware runtime.
          // An owner name or current operator login cannot replace its room
          // and source authority, including after workspace removal.
          if (
            (typeof metadata?.orgId === "string" && metadata.orgId.startsWith("team:")) ||
            (metadata &&
              (Object.hasOwn(metadata, "teamWorkspaceId") ||
                Object.hasOwn(metadata, "teamMembershipVersion")))
          ) {
            return Response.json(
              { error: "Use the shared room for team employee work." },
              { status: 403 },
            );
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
    return null;
  },
  async agentResponse(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    const agentResponse = await routeAgentRequest(request, {
      CodingOrchestrator: env.CodingOrchestrator,
    });
    if (agentResponse) {
      return agentResponse;
    }
    // An `/api/*` URL that survived every handler is an API miss, not a
    // page route — answer JSON instead of the marketing 404 HTML.
    return null;
  },
  async apiMiss(context: RequestContext): Promise<Response | null> {
    const { request, env, url } = context;
    if (url.pathname.startsWith("/api/")) {
      if (isOrgApiPath(url.pathname)) {
        const auth = await resolveOrgForApiRequest(request, env);
        if (auth instanceof Response) return auth;
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return null;
  },
  async assets(context: RequestContext): Promise<Response | null> {
    const { request, env } = context;
    return env.ASSETS.fetch(request);
  },
};
