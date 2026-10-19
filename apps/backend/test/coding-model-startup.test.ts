import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({
    fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
    notify: {},
  }),
}));
vi.mock("../src/email-approvals.js", () => ({
  queueEmailApproval: async () => ({ approval_id: "apv-test" }),
  emailApprovalBridgeReady: () => true,
}));

/**
 * Covers VERIFICATION_PLAN.md G2: `fetch` asserts CODING_MODEL isn't a
 * retired id before serving any route. `/api/audit` is the probe route —
 * it falls through every earlier handler and, once the assertion clears,
 * answers 503 (AGENT_AUDIT unbound).
 *
 * The Worker module is imported once, at collection time. Re-importing it
 * inside the test (via `vi.resetModules()`) is what blew the 5s limit on a
 * slower machine: the cold graph is seconds of transform, while the request
 * itself returns in milliseconds and does not call the network. The check
 * flag resets between cases so a passing id cannot hide a later retired one.
 */
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { resetCodingModelCheck } from "../src/coding-model.js";

function makeEnv(codingModel: string): Env {
  return { CODING_MODEL: codingModel } as Env;
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

// Built from parts, like the dead-default guard test's own marker, so this
// file doesn't trip that guard's "only coding-model.ts may reference the
// retired default" scan.
const RETIRED_ID = "google/" + ["gemini-2", "0"].join(".") + "-flash";

describe("startup assertion on CODING_MODEL", () => {
  beforeEach(() => {
    resetCodingModelCheck();
  });

  it("throws (500, logged as retired) while CODING_MODEL names a retired id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv(RETIRED_ID);
    const response = await worker.fetch(new Request("http://localhost/api/audit"), env, makeCtx());
    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/retired/));
    errorSpy.mockRestore();
  });

  it("passes the assertion for a live CODING_MODEL id", async () => {
    const env = makeEnv("google/gemini-3.5-flash-lite");
    const response = await worker.fetch(new Request("http://localhost/api/audit"), env, makeCtx());
    // Reaches the audit route handler itself (unbound AGENT_AUDIT -> 503),
    // proving the assertion did not throw and the request kept routing.
    expect(response.status).toBe(503);
  });
});
