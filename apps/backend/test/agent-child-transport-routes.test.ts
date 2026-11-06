import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { TEST_ACCESS_AUD, verifiedAccessHeaders } from "./fixtures/access-identity.js";

const routing = vi.hoisted(() => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("agents/routing", () => routing);
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {}, ContainerProxy: class {}, proxyToSandbox: async () => null, getSandbox: vi.fn(),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

const OWNER = "submarine@example.test";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env = { ACCESS_AUD: TEST_ACCESS_AUD, REQUIRE_ACCESS: "1", CodingOrchestrator: {} } as unknown as Env;
let worker: (typeof import("../src/index.js"))["default"];
beforeAll(async () => { worker = (await import("../src/index.js")).default; }, 60_000);
beforeEach(() => {
  routing.getAgentByName.mockReset().mockResolvedValue({ fetch: async () => Response.json({ parent: true }) });
  routing.routeAgentRequest.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

const childPaths = [
  "/sub/explorer-agent/retained/get-messages",
  "/sub/reviewer-agent/guessed",
  "/sub/open-code-agent/guessed",
  "/sub/unknown-agent/guessed",
  "/sub",
  "/%73%75%62/unknown-agent/guessed",
  "/prefix%2fsub%2funknown-agent%2fguessed",
] as const;

function request(suffix: string, owner: string, headers: Record<string, string>, socket = true) {
  return new Request(`https://dashboard.example.test/agents/coding-orchestrator/${encodeURIComponent(owner)}${suffix}`, {
    headers: { Origin: "https://dashboard.example.test", ...(socket ? { Upgrade: "websocket" } : {}), ...headers },
  });
}

describe("public child transport closure", () => {
  it.each(childPaths)("rejects an owner's child path %s before any binding lookup", async (suffix) => {
    const headers = await verifiedAccessHeaders(OWNER);
    for (const name of [OWNER, `web:${OWNER}:${SESSION}`]) {
      for (const socket of [false, true]) {
        const response = await worker.fetch(request(suffix, name, headers, socket), env);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found." });
      }
    }
    expect(routing.getAgentByName).not.toHaveBeenCalled();
    expect(routing.routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each(childPaths)("authenticates unsigned and forged identity requests before disclosing %s", async (suffix) => {
    const attempts: Record<string, string>[] = [{}, { "CF-Access-Authenticated-User-Email": OWNER }, {
      "CF-Access-Authenticated-User-Email": OWNER, "Cf-Access-Jwt-Assertion": "forged-token",
    }];
    for (const headers of attempts) {
      for (const socket of [false, true]) {
        const response = await worker.fetch(request(suffix, OWNER, headers, socket), env);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "Authentication required." });
      }
    }
    expect(routing.getAgentByName).not.toHaveBeenCalled();
    expect(routing.routeAgentRequest).not.toHaveBeenCalled();
  });

  it.each(["", "/get-messages", "/submarine", "?selected=sub"])("preserves the actual parent transport %s", async (suffix) => {
    const response = await worker.fetch(request(suffix, OWNER, await verifiedAccessHeaders(OWNER)), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ parent: true });
    expect(routing.getAgentByName).toHaveBeenCalledWith(env.CodingOrchestrator, OWNER);
  });

  it("does not disclose child routes to another signed owner or forward malformed encoding", async () => {
    const headers = await verifiedAccessHeaders("other@example.test");
    expect((await worker.fetch(request("/sub/unknown/id", OWNER, headers), env)).status).toBe(403);
    const ownerHeaders = await verifiedAccessHeaders(OWNER);
    expect((await worker.fetch(request("/%xy/unknown/id", OWNER, ownerHeaders), env)).status).toBe(400);
    expect(routing.getAgentByName).not.toHaveBeenCalled();
  });
});
