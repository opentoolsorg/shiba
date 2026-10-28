import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { handleOrgAgents } from "../src/v1/org-agents.js";
import type { V1Context } from "../src/v1/context.js";

const mocks = vi.hoisted(() => ({
  authorized: true,
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../src/org-request-auth.js", () => ({
  resolveOrgForApiRequest: async () => mocks.authorized
    ? { orgId: "org-a", principal: null }
    : Response.json({ error: "unauthorized" }, { status: 401 }),
}));
vi.mock("../src/custom-agents-store.js", () => ({
  listCustomAgents: mocks.list,
  getCustomAgentById: mocks.get,
  createCustomAgent: mocks.create,
  updateCustomAgent: mocks.update,
  deleteCustomAgent: mocks.remove,
}));

const env = { AGENT_AUDIT: {} as D1Database } as unknown as Env;
const agent = {
  id: "cag-existing", orgId: "org-a", slug: "existing", version: 1,
  config: { name: "Existing", instructions: "Inspect", harness: "opencode" },
  createdAt: 1, updatedAt: 2,
};

function untouched() {
  for (const method of [mocks.list, mocks.get, mocks.create, mocks.update, mocks.remove]) {
    expect(method).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorized = true;
  mocks.list.mockResolvedValue([agent]);
  mocks.get.mockResolvedValue(agent);
  mocks.remove.mockResolvedValue(undefined);
});

describe("custom-agent route boundaries", () => {
  it.each([
    "/api/custom-agents-extra",
    "/api/custom-agents/cag-existing/extra",
    "/api/custom-agents/cag-existing/extra/",
    "/api/custom-agents//cag-existing",
    "/api/custom-agents//",
  ])("does not delete or read an agent through unsupported path %s", async (path) => {
    const response = await handleCustomAgents(new Request(`https://worker.test${path}`, { method: "DELETE" }), env);
    expect(response?.status).toBe(404);
    untouched();
  });

  it.each(["%", "%E0%A4%A", "%FF", "cag%2Fexisting", "cag%5Cexisting"])(
    "rejects invalid or ambiguous encoded agent id %s without storage access",
    async (id) => {
      const response = await handleCustomAgents(new Request(`https://worker.test/api/custom-agents/${id}`, { method: "DELETE" }), env);
      expect(response?.status).toBe(400);
      untouched();
    },
  );

  it("authenticates before decoding a potentially private resource id", async () => {
    mocks.authorized = false;
    const response = await handleCustomAgents(new Request("https://worker.test/api/custom-agents/%FF"), env);
    expect(response?.status).toBe(401);
    untouched();
  });

  it.each(["/api/custom-agents", "/api/custom-agents/"])("preserves collection GET at %s", async (path) => {
    const response = await handleCustomAgents(new Request(`https://worker.test${path}`), env);
    expect(response?.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(env, "org-a");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["/api/custom-agents/cag-existing", "/api/custom-agents/cag-existing/"])(
    "preserves an exact single-agent GET at %s", async (path) => {
      const response = await handleCustomAgents(new Request(`https://worker.test${path}`), env);
      expect(response?.status).toBe(200);
      expect(mocks.get).toHaveBeenCalledWith(env, "org-a", "cag-existing", { includeArchived: true });
    },
  );

  it("preserves DELETE on the exact resource", async () => {
    const response = await handleCustomAgents(new Request("https://worker.test/api/custom-agents/cag-existing", { method: "DELETE" }), env);
    expect(response?.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(env, "org-a", "cag-existing");
  });

  it.each([
    ["/api/v1/org-agents/cag-existing/extra", 404],
    ["/api/v1/org-agents-extra", 404],
    ["/api/v1/org-agents/%E0%A4%A", 400],
  ])("applies the same route validation through alias %s", async (path, status) => {
    const request = new Request(`https://worker.test${path}`, { method: "DELETE" });
    const context: V1Context = {
      request, url: new URL(request.url), env,
      principal: { principal: "owner", orgId: "org-a", scopes: ["api:read", "api:write"] },
      forward: vi.fn(),
    };
    expect((await handleOrgAgents(context))?.status).toBe(status);
    untouched();
  });

  it("leaves unrelated paths to their own handlers", async () => {
    expect(await handleCustomAgents(new Request("https://worker.test/api/other"), env)).toBeNull();
    untouched();
  });
});
