/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { createRequestContext } from "./routes/context.js";
import { dispatchRoutes } from "./routes/table.js";
import { timeAuth, withRequestTiming, withTimingDatabase } from "./platform/request-timing.js";
import { getAgentByName } from "agents/routing";
import { consumeScheduledJobs, runScheduledJobs } from "./scheduled-jobs.js";
import { Automations } from "./automations-do.js";
import { automationsStub } from "./automations-stub.js";
import { ensureLiveCodingModel } from "./coding-model.js";
import type { Env } from "./env.js";
import { Mailbox } from "./mailbox-do.js";
import { MCP_PRINCIPAL_HEADER } from "./mcp-principal.js";
import { Memory } from "./memory-do.js";
import { Sandbox, SandboxOutbound } from "./sandbox.js";
import { ContainerProxy } from "./sandbox/npm-shim.js";
import { withVerifiedAccessIdentity } from "./access-jwt.js";
import { enforceTeamMemberApiPolicy } from "./team-member-auth.js";
import { LocalDispatch } from "./local-dispatch.js";
import { Spaces } from "./spaces-do.js";
import { ComputerSession } from "./computer-session.js";
import { redactSecrets } from "./security.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { isAccessConfigured, isAuthorizedRequest } from "./request-auth.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { isOrgApiPath, isPublicRequest } from "./public-routes.js";
import { Waitlist } from "./waitlist-do.js";
import { ModelConfig } from "./model-config-do.js";
import { ChatGptAuth } from "./chatgpt-auth-do.js";
import { UserProviderOAuth } from "./user-provider-oauth-do.js";
import { ConversationRoom } from "./conversation-room-do.js";
import { WorkspaceEvents } from "./platform/workspace-events-do.js";
import { SlackImportWorkflow, AutomationRunWorkflow } from "./platform/workflows.js";
import { dispatchQueueBatch } from "./platform/queues.js";
// Rarely-hit route and cron handlers (founder-*, report/slack coworker, v1,
// collaboration, team-model, first-run seed, inbound email) are loaded with
// `await import()` at their call sites: evaluating them at Worker startup
// pushed deploys past the startup CPU limit.

export { CodingOrchestrator } from "./agents/orchestrator.js";
export { OpenCodeAgent } from "./agents/opencode-agent.js";
export { ExplorerAgent } from "./agents/specialists/explorer-agent.js";
export { ReviewerAgent } from "./agents/specialists/reviewer-agent.js";
export {
  Automations,
  ChatGptAuth,
  ConversationRoom,
  ComputerSession,
  UserProviderOAuth,
  LocalDispatch,
  Mailbox,
  Memory,
  ModelConfig,
  Sandbox,
  SandboxOutbound,
  ContainerProxy,
  Waitlist,
  Spaces,
  WorkspaceEvents,
  SlackImportWorkflow,
  AutomationRunWorkflow,
};
export { assertLiveCodingModel } from "./coding-model.js";
// Kept public for consumers that import the auth surface from the entry.
export { isBetterAuthConfigured } from "./better-auth.js";
export {
  getUserId,
  isAuthenticated,
  isAuthorizedRequest,
  resolveUserId,
  SIGNATURE_AUTHENTICATED,
} from "./request-auth.js";
export { handleWebSessions } from "./sessions-routes.js";

export { getDashboardViews } from "./app-host-routing.js";

let claudeSubscriptionDeprecationWarned = false;

export default {
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (/^shiba-jobs(?:-|$)/.test(batch.queue)) await consumeScheduledJobs(batch, env);
    else await dispatchQueueBatch(batch, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledJobs(controller.scheduledTime ?? Date.now(), env));
  },
  // Email Routing delivery — registered-mailbox gate + store, see email-handler.ts.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await (await import("./email-handler.js")).handleInboundEmail(message, env, ctx);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return withRequestTiming(request, async () => {
    env = withTimingDatabase(env);
    try {
      // A one-purpose Worker capability, verified before any identity or D1 lookup.
      // No dashboard, model or Durable Object execution authority is inherited.
      const capabilityResponse = await dispatchRoutes(
        "capability",
        createRequestContext(request, env, ctx),
      );
      if (capabilityResponse) return capabilityResponse;
      if (!claudeSubscriptionDeprecationWarned && env.SHIBA_CLAUDE_SUBSCRIPTION === "1") {
        claudeSubscriptionDeprecationWarned = true;
        console.warn(
          "SHIBA_CLAUDE_SUBSCRIPTION is enabled: the claude-subscription harness stores Claude.ai tokens at the Worker egress boundary, which may violate Anthropic's terms — prefer claude-login (https://code.claude.com/docs/en/legal-and-compliance).",
        );
      }
      request = await timeAuth(() => withVerifiedAccessIdentity(request, env));
      // MCP_PRINCIPAL_HEADER is minted only by the verified-bearer path in
      // handleMcp — no external caller may set it. Strip at ingress so a
      // future route cannot accidentally trust a client-supplied copy.
      if (request.headers.has(MCP_PRINCIPAL_HEADER)) {
        const headers = new Headers(request.headers);
        headers.delete(MCP_PRINCIPAL_HEADER);
        request = new Request(request, { headers });
      }
      const url = new URL(request.url);
      const context = createRequestContext(request, env, ctx);
      const ingressResponse = await dispatchRoutes("ingress", context);
      if (ingressResponse) return ingressResponse;
      if (
        !isPublicRequest(request) &&
        !isOrgApiPath(url.pathname) &&
        !(await isAuthorizedRequest(request, env))
      ) {
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
      // Table adapters, including `await handleGmail(request, env)`, run only after this gate.
      const memberPolicyResponse = await enforceTeamMemberApiPolicy(request, env);
      if (memberPolicyResponse) return memberPolicyResponse;
      const authenticatedResponse = await dispatchRoutes("authenticated", context);
      if (authenticatedResponse) return authenticatedResponse;
      ensureLiveCodingModel(env);
      const response = await dispatchRoutes("model", context);
      if (response) return response;
      throw new Error("Route table has no final response.");
    } catch (error) {
      // The client gets a generic 500; the redacted detail stays in the log.
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
      return Response.json({ error: "Internal error." }, { status: 500 });
    }
    });
  },
} satisfies ExportedHandler<Env>;
