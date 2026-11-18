import { expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import after from "../../src/index.js";
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));
// Status codes captured from 1f8110a9 before the table conversion, with no bindings.
// Exercise both a signed-out remote request and the existing loopback development lane.
const GET_PARITY: [string, number, number][] = [
  ["/", 200, 200],
  ["/work", 200, 200],
  ["/docs/intro", 301, 301],
  ["/auth/reset", 200, 200],
  ["/spaces/one", 200, 200],
  ["/share/c/token", 200, 200],
  ["/api/share/file/token", 404, 404],
  ["/api/share", 405, 405],
  ["/api/run-output-archives", 401, 403],
  ["/api/slack/installations", 401, 400],
  ["/api/shared-computers", 401, 403],
  ["/api/workspace-integrations", 401, 400],
  ["/api/personal-execution", 401, 404],
  ["/api/team-model-sessions", 401, 403],
  ["/api/needs-you", 401, 401],
  ["/api/workspaces/ws_one/work", 401, 404],
  ["/api/workspaces/ws_one/primary-bot", 401, 401],
  ["/api/search", 401, 404],
  ["/api/palette/bots", 401, 404],
  ["/api/runs/run/ask-user/pending", 401, 200],
  ["/api/workspaces", 401, 401],
  ["/api/workspaces/ws_one/events", 401, 401],
  ["/api/governance", 401, 401],
  ["/api/governanceX", 401, 401],
  ["/api/email/delivery-status", 401, 200],
  ["/api/first-run-seed", 401, 405],
  ["/api/employee-bundles", 401, 404],
  ["/api/connections/gmail", 401, 401],
  ["/oauth/authorize", 401, 400],
  ["/oauth/token", 200, 200],
  ["/.well-known/oauth-authorization-server", 200, 200],
  ["/api/waitlist", 401, 503],
  ["/api/admin/waitlist", 401, 503],
  ["/api/health", 200, 200],
  ["/api/whoami", 401, 200],
  ["/api/setup/status", 401, 200],
  ["/api/onboarding/progress/team-task", 401, 403],
  ["/api/providers", 401, 200],
  ["/api/capabilities", 401, 200],
  ["/api/api-keys", 401, 200],
  ["/api/webhooks", 401, 404],
  ["/api/custom-agents", 401, 503],
  ["/api/employee-tools", 401, 404],
  ["/api/reason-network", 401, 503],
  ["/api/skills/library", 401, 503],
  ["/api/skills", 401, 503],
  ["/api/spaces", 401, 503],
  ["/api/founder-skills", 401, 401],
  ["/api/org/sandbox", 503, 503],
  ["/mcp", 401, 401],
  ["/api/local", 404, 404],
  ["/api/approvals", 401, 500],
  ["/api/collaboration", 401, 401],
  ["/api/computers", 401, 404],
  ["/api/slack-canvas", 401, 401],
  ["/api/runs", 401, 500],
  ["/api/v1/openapi.json", 200, 200],
  ["/api/integrations/provider/callback", 200, 200],
  ["/api/github/webhook", 405, 405],
  ["/internal/mailbox/list", 401, 404],
  ["/api/missing", 401, 404],
];

it("retains all 61 GET probes", () => {
  expect(GET_PARITY).toHaveLength(61);
});

it.each(GET_PARITY)(
  "preserves GET %s from the starting commit",
  async (path, remoteStatus, localStatus) => {
    for (const [host, status] of [
      ["example.test", remoteStatus],
      ["localhost", localStatus],
    ] as const) {
      const env = { ASSETS: { fetch: async () => new Response("static") } } as unknown as Env;
      const response = await after.fetch(new Request(`http://${host}${path}`), env);
      expect(response.status, `${host}${path}`).toBe(status);
    }
  },
);
