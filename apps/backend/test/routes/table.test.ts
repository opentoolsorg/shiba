import { describe, expect, it, vi } from "vitest";
import { isPublicStaticPath } from "../../src/public-routes.js";
import type { Env } from "../../src/env.js";
import { createRequestContext } from "../../src/routes/context.js";
import { dispatchRoutes, matchesRoute, ROUTES } from "../../src/routes/table.js";

// Deliberate anonymous surfaces. Adding public access requires a reason here.
const PUBLIC_ROUTES: Record<string, string> = {
  betterAuthResponse: "Sign-in, account enrollment and session protocol verify their own verbs.",
  callback: "Slack OAuth callback verifies pending state and owner.",
  discordInstallCallback: "Verifies single-use OAuth state and the original session.",
  shell: "GET serves a static shell or redirects marketing content.",
  "shell-head": "HEAD serves the same static shell or redirect.",
  "share-read": "Unexpired share token grants read-only capability access.",
  "oauth-public": "OAuth clients require anonymous discovery, registration and grant exchange.",
  "waitlist-signup": "Anonymous POST signup; other methods remain gated at ingress.",
  health: "Read-only GET/HEAD liveness; other methods remain gated at ingress.",
  "v1-schema": "Published GET API schema; other methods remain gated at ingress.",
  "public-static": "GET public site content and browser assets carry no private data.",
  "public-static-head": "HEAD public site content and browser assets carry no private data.",
  "provider-callback": "Provider OAuth callback verifies pending state.",
};

// Every grouped matcher has a representative path. Include adjacent-prefix and
// nested cases because legacy handlers sometimes deliberately use raw prefixes.
const PATHS = [
  "/internal/founder-automatic-read/permit",
  "/internal/mailbox/list",
  "/api/artifacts/download",
  "/api/auth/sign-in/email",
  "/api/auth/codex-subscription/status",
  "/api/slack/installations/callback",
  "/api/discord/installations/callback",
  "/api/discord/installations",
  "/api/dev/oauth-loopback",
  "/",
  "/settings/",
  "/docs/intro",
  "/auth/reset",
  "/spaces/one",
  "/share/c/token",
  "/api/share/file/token",
  "/api/share",
  "/api/run-output-archives",
  "/api/slack/installations",
  "/api/teams/connection",
  "/api/slack/coworker",
  "/api/shared-computers",
  "/api/workspace-integrations",
  "/api/sessions/browser",
  "/api/browser-logins",
  "/api/browser-logins/bl_fixture",
  "/api/personal-execution",
  "/api/team-model-sessions",
  "/api/needs-you",
  "/api/workspaces/ws_one/work",
  "/api/workspaces/ws_one/primary-bot",
  "/api/search",
  "/api/palette/bots",
  "/api/runs/run/ask-user/pending",
  "/api/runs/run/ui-blocks",
  "/api/learning/settings",
  "/api/governance/employees/emp/access",
  "/api/admin/flags",
  "/api/workspaces",
  "/api/workspaces/ws_one/events",
  "/api/governance",
  "/api/governanceX",
  "/api/email/delivery-status",
  "/api/first-run-seed",
  "/api/employee-bundles",
  "/api/connections/gmail",
  "/oauth/authorize",
  "/oauth/token",
  "/.well-known/oauth-authorization-server",
  "/api/waitlist",
  "/api/admin/waitlist",
  "/api/health",
  "/api/observability",
  "/api/whoami",
  "/api/setup/status",
  "/api/onboarding/progress/team-task",
  "/api/onboarding/progress",
  "/api/providers",
  "/api/capabilities",
  "/api/api-keys",
  "/api/webhooks",
  "/api/custom-agents",
  "/api/employee-tools",
  "/api/reason-network",
  "/api/skills/library",
  "/api/skills",
  "/api/spaces",
  "/api/founder-skills/skill/connector-job",
  "/api/founder-skills/skill/reports/report/slack",
  "/api/founder-skills/skill/automatic-reads",
  "/api/founder-stripe-reads",
  "/api/founder-meta-reads",
  "/api/founder-hubspot-reads",
  "/api/founder-reconciliations",
  "/api/founder-reconciliation-schedules",
  "/api/founder-reconciliation-slack",
  "/api/founder-stripe-slack",
  "/api/founder-skills/skill/automatic-slack",
  "/api/founder-skills/skill/reports",
  "/api/founder-skills",
  "/api/org/sandbox",
  "/api/org/model-keys",
  "/api/subscription/openai",
  "/mcp",
  "/api/local",
  "/api/approvals",
  "/api/collaboration",
  "/api/workspace-notifications",
  "/api/slack-import",
  "/api/computers",
  "/api/dens/one",
  "/api/slack-canvas",
  "/api/runs",
  "/api/spine",
  "/api/tasks",
  "/api/employee-drafts",
  "/api/swarm/share",
  "/api/v1/openapi.json",
  "/api/v1/tasks",
  "/api/usage",
  "/api/billing",
  "/api/billing/checkout",
  "/api/billing/stripe/webhook",
  "/api/voice/transcribe",
  "/api/activity",
  "/api/screenshots/one",
  "/api/e2e-evidence/run/file",
  "/api/sessions",
  "/api/rooms/room/websocket",
  "/api/mailboxes",
  "/api/emails-search",
  "/api/threads/one",
  "/api/drafts",
  "/api/memory/facts",
  "/api/files",
  "/api/files/file_0123456789abcdef01234567/app-preview",
  "/api/notes",
  "/api/knowledge/search",
  "/api/projects",
  "/api/outputs",
  "/api/audit",
  "/api/sandboxes/one/info",
  "/api/telegram/webhook",
  "/api/discord/interactions",
  "/api/teams/messages",
  "/api/slack/events",
  "/api/slack/command",
  "/api/trigger",
  "/api/slack/interact",
  "/api/automations/one/trigger",
  "/api/automations",
  "/api/github/webhook",
  "/api/linear/webhook",
  "/api/integrations/github/status",
  "/api/operator-enrollment-reviews",
  "/api/integrations/provider/callback",
  "/api/integrations/provider/status",
  "/api/sentry/webhook",
  "/agents/coding-orchestrator/user",
  "/assets/file.js",
  "/api/missing",
];
const request = (path: string, method = "GET") =>
  new Request(`https://example.test${path}`, { method });

// Exact reviewed pairs, including pass-through SDK adapters and final fallbacks.
// The broad workspace handler already consumes events; changing that is separate work.
const INTENDED_SHADOWS = Object.fromEntries(
  [
    ["acpProviderResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["activityResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["adminFlagsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["agentResponse", "apiMiss assets public-static public-static-head", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["agents", "agentResponse assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["apiKeysResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["apiMiss", "assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["approvalsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["artifactDownload", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["employeeAccessResponse", "agentResponse apiMiss assets governanceResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["learningResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["uiBlockResponse", "agentResponse apiMiss assets runsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["askUserResponse", "agentResponse apiMiss assets runsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["auditResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["automation-trigger", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["automations", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["betterAuthResponse", "agentResponse apiMiss assets sandboxResponse subscriptionAuthResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["billing", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["billingWebhook", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["browserResponse", "agentResponse apiMiss assets sandboxResponse webSessionsResponse", "The authenticated browser endpoint owns its exact path and never falls back to generic session or asset handlers."],
    ["bundleResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["callback", "agentResponse apiMiss assets sandboxResponse slackInstallationResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["callbackMethod", "agentResponse apiMiss assets discordResponse linearWebhookResponse managedSlackResponse sandboxResponse sentryResponse slackEventsResponse slackInteractResponse slackResponse telegramResponse triggerResponse webhookResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["capabilityCatalogResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["collaborationResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["computersResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["customAgentsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["denResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["dev-oauth-post", "agentResponse apiMiss assets dev-oauth-session sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["dev-oauth-session", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["discordInstallCallback", "agentResponse apiMiss assets discordInstallationResponse sandboxResponse", "OAuth callback validates state before authenticated API dispatch."],
    ["discordInstallationResponse", "agentResponse apiMiss assets sandboxResponse", "Authenticated Discord management precedes API fallbacks."],
    ["discordResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["e2eEvidenceResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["emailDeliveryResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["employeeToolsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["enrollment", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["filesResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["fileAppPreviewResponse", "agentResponse apiMiss assets filesResponse sandboxResponse", "Exact Access-only preview ends before the generic file, session, model and asset fallbacks."],
    ["founderAutomaticResponse", "agentResponse apiMiss assets founderSkillsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderAutomaticSlackResponse", "agentResponse apiMiss assets founderSkillsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderConnectorResponse", "agentResponse apiMiss assets founderSkillsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderEvidenceResponse", "agentResponse apiMiss assets founderSkillsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderHubSpotResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderMetaResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderSkillsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["founderStripeResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["gmailResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["governanceResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["health", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["inboxResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["integrationsResponse", "agentResponse apiMiss assets provider provider-callback", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["internal", "agentResponse assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["knowledgeResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["linearWebhookResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["local", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["managedSlackResponse", "agentResponse apiMiss assets slackEventsResponse slackInteractResponse slackResponse", "Managed Slack verification precedes legacy callback verification."],
    ["mcpResponse", "agentResponse assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["memoryResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["metadata", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["notesResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["notificationsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["oauth-consent", "agentResponse assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["oauth-public", "agentResponse assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["onboardingResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["orgModelKeysResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["observabilityResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["orgSandboxResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["outboundWebhooksResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["outputArchiveResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["outputsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["paletteResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["permit", "agentResponse assets internal sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["personalExecutionResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["primaryBotResponse", "agentResponse apiMiss assets sandboxResponse workspaceResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["projectsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["provider", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["provider-callback", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["public-static", "assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["public-static-head", "assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["reasonNetworkResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["reconciliationResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["reconciliationSlackResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["reportSlackResponse", "agentResponse apiMiss assets founderEvidenceResponse founderSkillsResponse sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["runsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["sandboxResponse", "activityResponse agentResponse agents apiMiss assets auditResponse automation-trigger automations billing billingWebhook denResponse discordResponse e2eEvidenceResponse enrollment filesResponse inboxResponse integrationsResponse knowledgeResponse linearWebhookResponse managedSlackResponse memoryResponse notesResponse outputsResponse projectsResponse provider provider-callback public-static public-static-head runsResponse sandboxRouteResponse screenshotResponse sentryResponse slackCanvasResponse slackEventsResponse slackInteractResponse slackResponse swarmResponse teamsResponse telegramResponse triggerResponse usageResponse v1 v1-schema voiceResponse webSessionsResponse webhookResponse", "SDK sandbox proxy can decline before normal routing."],
    ["sandboxRouteResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["screenshotResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["searchResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["seedResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["sentryResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["share-early-management", "agentResponse apiMiss assets sandboxResponse share-late", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["share-late", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["share-read", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["sharedComputerResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["shell", "agentResponse assets public-static sandboxResponse share-read", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["shell-head", "agentResponse assets public-static-head sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["skillLibraryResponse", "agentResponse apiMiss assets sandboxResponse skillsResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["skillsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackCanvasResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackCoworkerResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackEventsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackImportResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackInstallationResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["teamsConnectionResponse", "agentResponse apiMiss assets sandboxResponse", "The native owner route always handles this exact connection path before generic routing."],
    ["slackInteractResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["slackResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["spacesResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["standingComparisonResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["stripeSlackResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["subscriptionAuthResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["swarmResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["teamModelResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["teamOnboardingTask", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["teamsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["telegramResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["triggerResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["usageResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["userOpenAiSubscriptionResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["v1", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["v1-schema", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["voiceResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["waitlist-admin", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["waitlist-signup", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["webSessionsResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["webhookResponse", "agentResponse apiMiss assets", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["workResponse", "agentResponse apiMiss assets sandboxResponse workspaceResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["workspaceEventsResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["workspaceIntegrationResponse", "agentResponse apiMiss assets sandboxResponse", "Earlier adapter retains precedence and may fall through to later handlers."],
    ["workspaceResponse", "agentResponse apiMiss assets sandboxResponse workspaceEventsResponse", "Existing workspace handler consumes the events route before its later adapter."],
  ].flatMap(([earlier, later, reason]) =>
    (later ?? "").split(" ").map((id) => [`${earlier} > ${id}`, reason ?? ""]),
  ),
);

function overlappingPairs(): string[] {
  const pairs = new Set<string>();
  for (const path of PATHS) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const candidate = request(path, method);
      const matching = ROUTES.filter((entry) => matchesRoute(entry, candidate));
      for (let i = 0; i < matching.length; i++) {
        for (const later of matching.slice(i + 1)) pairs.add(`${matching[i]?.id} > ${later.id}`);
      }
    }
  }
  return [...pairs].sort();
}

describe("reviewed route table", () => {
  it("declares auth and a callable adapter for every unique route", () => {
    expect(new Set(ROUTES.map((entry) => entry.id)).size).toBe(ROUTES.length);
    for (const entry of ROUTES) {
      expect(["session", "access", "signature", "bearer", "public", "internal"]).toContain(
        entry.auth,
      );
      expect(["*", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).toContain(entry.method);
      expect(typeof entry.handler).toBe("function");
      expect(
        PATHS.some((path) => new RegExp(entry.pattern).test(path)),
        entry.id,
      ).toBe(true);
    }
  });

  it("allows public routes only after an explicit review with a reason", () => {
    expect(
      ROUTES.filter((entry) => entry.auth === "public")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(Object.keys(PUBLIC_ROUTES).sort());
    for (const reason of Object.values(PUBLIC_ROUTES)) expect(reason.length).toBeGreaterThan(20);
  });

  it("has only explicitly allowlisted matcher intersections", () => {
    expect(overlappingPairs()).toEqual(Object.keys(INTENDED_SHADOWS).sort());
    for (const reason of Object.values(INTENDED_SHADOWS)) expect(reason.length).toBeGreaterThan(20);
  });

  it("snapshots ordered methods, patterns, auth and review notes", () => {
    expect(
      ROUTES.map(({ id, phase, method, pattern, auth, note }) =>
        [id, phase, method, pattern, auth, note].join(" | ").trimEnd(),
      ).join("\n"),
    ).toMatchSnapshot();
  });

  it("keeps grouped root and raw-prefix matchers", () => {
    for (const [id, path] of [
      ["gmailResponse", "/api/connections/gmail"],
      ["collaborationResponse", "/api/collaboration"],
      ["governanceResponse", "/api/governanceX"],
      ["skillLibraryResponse", "/api/skills/libraryX"],
    ]) {
      const entry = ROUTES.find((candidate) => candidate.id === id);
      expect(entry && matchesRoute(entry, request(path ?? "")), id).toBe(true);
    }
  });

  it("declares the existing public static policy for GET and HEAD", () => {
    const paths = [
      ...PATHS,
      "/index.html",
      "/waitlist/index.html",
      "/why-shiba/",
      "/docs/",
      "/_astro/main.js",
      "/pagefind/index.js",
      "/favicon.ico",
      "/favicon.svg",
      "/favicon-32x32.png",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap-index.xml",
      "/sitemap-0.xml",
      "/llms.txt",
      "/404.html",
      "/app/",
      "/docs-private",
      "/assets-private",
      "/api/private",
    ];
    for (const path of paths) {
      for (const method of ["GET", "HEAD"]) {
        const candidate = request(path, method);
        expect(
          ROUTES.some(
            (entry) => entry.id.startsWith("public-static") && matchesRoute(entry, candidate),
          ),
          `${method} ${path}`,
        ).toBe(isPublicStaticPath(path));
      }
    }
  });

  it("dispatches phase and method before touching handlers", async () => {
    const fetch = vi.fn(async () => new Response("shell"));
    const env = { ASSETS: { fetch } } as unknown as Env;
    expect(await dispatchRoutes("capability", createRequestContext(request("/"), env))).toBeNull();
    expect(
      await dispatchRoutes("ingress", createRequestContext(request("/", "POST"), env)),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((await dispatchRoutes("ingress", createRequestContext(request("/"), env)))?.status).toBe(
      200,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
