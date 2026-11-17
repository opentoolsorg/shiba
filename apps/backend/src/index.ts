/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { createRequestContext } from "./routes/context.js";
import { dispatchRoutes } from "./routes/table.js";
import { getAgentByName } from "agents/routing";
import { OpenCodeAgent } from "./agents/opencode-agent.js";
import { CodingOrchestrator } from "./agents/orchestrator.js";
import { ExplorerAgent } from "./agents/specialists/explorer-agent.js";
import { ReviewerAgent } from "./agents/specialists/reviewer-agent.js";
import { AUDIT_RETENTION_MS, pruneAuditLog } from "./audit.js";
import { Automations } from "./automations-do.js";
import { automationsStub } from "./automations-stub.js";
import { ensureLiveCodingModel } from "./coding-model.js";
import type { Env } from "./env.js";
import { Mailbox } from "./mailbox-do.js";
import { MCP_PRINCIPAL_HEADER } from "./mcp-gateway.js";
import { Memory } from "./memory-do.js";
import { Sandbox, SandboxOutbound } from "./sandbox.js";
import { ContainerProxy } from "./sandbox/npm-shim.js";
import { withVerifiedAccessIdentity } from "./access-jwt.js";
import { enforceTeamMemberApiPolicy } from "./team-member-auth.js";
import { LocalDispatch } from "./local-dispatch.js";
import { pruneCapabilityInvocations } from "./capability-invocations.js";
import { registerWebhookQueueConsumers } from "./webhooks/consumer.js";
import { Spaces } from "./spaces-do.js";
import { ComputerSession } from "./computer-session.js";
import { redactSecrets } from "./security.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import "./email/delivery.js";
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
import "./knowledge/knowledge-ingest-queue.js";
// Rarely-hit route and cron handlers (founder-*, report/slack coworker, v1,
// collaboration, team-model, first-run seed, inbound email) are loaded with
// `await import()` at their call sites: evaluating them at Worker startup
// pushed deploys past the startup CPU limit.

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

registerWebhookQueueConsumers();

let claudeSubscriptionDeprecationWarned = false;

export { DASHBOARD_VIEWS } from "./routes/shell.js";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    await dispatchQueueBatch(batch, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try { await (await import("./founder-stripe-runtime.js")).tickFounderStripeReads(env); }
      catch (error) { console.error("Founder Stripe read scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-meta-runtime.js")).tickFounderMetaReads(env); }
      catch (error) { console.error("Founder Meta read scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-hubspot-runtime.js")).tickFounderHubSpotReads(env); }
      catch (error) { console.error("Founder HubSpot read scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-reconciliation-schedule-runtime.js")).tickFounderReconciliationSchedules(env); }
      catch (error) { console.error("Founder standing comparison scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-auto-read-runtime.js")).tickFounderAutomaticReads(env); }
      catch (error) { console.error("Founder automatic read scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-automatic-slack-tick.js")).tickFounderAutomaticSlack(env); }
      catch (error) { console.error("Founder automatic Slack scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-automatic-slack-stripe-tick.js")).tickFounderStripeAutomaticSlack(env); }
      catch (error) { console.error("Founder Stripe Slack scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./founder-reconciliation-slack-tick.js")).tickFounderReconciliationSlack(env); }
      catch (error) { console.error("Founder combined-report Slack scheduling failed", redactSecrets(String(error))); }
      try { await (await import("./slack-coworker-private-status.js")).tickSlackCoworkerPrivateStatus(env); }
      catch (error) { console.error("Private Slack status scheduling failed", redactSecrets(String(error))); }
    })());
    ctx.waitUntil(import("./founder-review-schedules.js").then((m) => m.tickFounderReviewSchedules(env)).catch((error: unknown) => {
      console.error("Founder review scheduling failed", redactSecrets(String(error)));
    }));
    ctx.waitUntil(import("./founder-connector-jobs.js").then((m) => m.tickFounderConnectorJobs(env)).catch((error: unknown) => {
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
    await (await import("./email-handler.js")).handleInboundEmail(message, env, ctx);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
  },
} satisfies ExportedHandler<Env>;
