import { routeAgentRequest } from "agents/routing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as access from "../../src/access-jwt.js";
import * as model from "../../src/coding-model.js";
import type { Env } from "../../src/env.js";
import * as employee from "../../src/governance/employee-route-auth.js";
import worker from "../../src/index.js";
import * as metadata from "../../src/meta-routes.js";
import * as auth from "../../src/request-auth.js";
import * as sandbox from "../../src/sandbox/proxy.js";
import * as member from "../../src/team-member-auth.js";
import { TEST_ACCESS_AUD, verifiedAccessHeaders } from "../fixtures/access-identity.js";

vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));
vi.mock("../../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const origin = "https://metadata.example.test";
const user = "operator@example.test";
const noBindings = {} as Env;
const request = (path: string, init?: RequestInit) => new Request(origin + path, init);

beforeEach(() => {
  model.resetCodingModelCheck();
  vi.mocked(routeAgentRequest).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("serves only exact public health reads before the live-model gate", async () => {
  const env = { INSTANCE_TYPE: "fixture-invalid" } as Env;
  expect(() => model.assertLiveCodingModel(env)).toThrow(/Unknown INSTANCE_TYPE/);
  const health = await worker.fetch(request("/api/health"), env);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  expect(health.headers.get("content-type")).toMatch(/^application\/json/);
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(health.headers.get("server-timing")).toMatch(/total;dur=/);
  const head = await worker.fetch(request("/api/health", { method: "HEAD" }), env);
  expect(head.status).toBe(200);
  expect(head.headers.get("cache-control")).toBe("no-store");
  for (const candidate of [
    request("/api/health", { method: "POST" }),
    request("/api/health", { method: "OPTIONS" }),
    request("/api/health/"),
  ]) {
    const response = await worker.fetch(candidate, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required.", code: "access_not_configured" });
  }
  const local = await worker.fetch(new Request("http://localhost/api/health", { method: "POST" }), env);
  expect(local.status).toBe(405);
  expect(await local.json()).toEqual({ error: "Method not allowed." });
});

it("preserves verified identity, deployment metadata contracts, and private email OpenAPI", async () => {
  const headers = await verifiedAccessHeaders(user);
  const env = { ACCESS_AUD: TEST_ACCESS_AUD, REQUIRE_ACCESS: "1" } as Env;
  const who = await worker.fetch(request("/api/whoami", { headers }), env);
  expect(who.status).toBe(200);
  expect(await who.json()).toEqual({ agent: user, auth: "access" });
  expect(who.headers.get("cache-control")).toBe("no-store");
  const deployment = await worker.fetch(request("/api/setup/deployment", { method: "POST", headers }), env);
  expect(deployment.status).toBe(405);
  expect(deployment.headers.get("allow")).toBe("GET");
  expect(deployment.headers.get("cache-control")).toBe("no-store");
  expect(await deployment.json()).toEqual({ error: "Method not allowed." });
  const absent = await worker.fetch(request("/api/setup/deployment", { headers }), env);
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({
    error: "This deployment has no verified version and Git revision tag.",
    code: "deployment_revision_unavailable",
  });
  const email = await worker.fetch(request("/api/email/openapi.json", { headers }), env);
  expect(email.status).toBe(200);
  expect(email.headers.get("cache-control")).toBe("no-store");
  expect(await email.json()).toHaveProperty("openapi");
  expect((await worker.fetch(request("/api/email/openapi.json"), env)).status).toBe(401);
  expect((await worker.fetch(request("/api/setup/deployment", {
    method: "POST", headers: { "CF-Access-Authenticated-User-Email": user },
  }), env)).status).toBe(401);
});

it("checks same origin before parsing malformed JSON and declines unmatched setup paths", async () => {
  const headers = await verifiedAccessHeaders(user);
  const assets = vi.fn(async () => new Response("fixture asset"));
  const env = { ACCESS_AUD: TEST_ACCESS_AUD, REQUIRE_ACCESS: "1", ASSETS: { fetch: assets } } as unknown as Env;
  const denied = await worker.fetch(request("/api/setup/fix", {
    method: "POST", headers: { ...headers, Origin: "https://other.example.test" }, body: "{",
  }), env);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "Same-origin request required." });
  const invalid = await worker.fetch(request("/api/setup/fix", {
    method: "POST", headers: { ...headers, Origin: origin }, body: "{",
  }), env);
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({
    ok: false, error: "invalid_request", userMessage: "Send JSON with an actionId.",
  });
  const miss = await worker.fetch(request("/api/setup/not-a-route", { headers }), env);
  expect(miss.status).toBe(404);
  expect(await miss.json()).toEqual({ error: "Not found." });
  expect(assets).not.toHaveBeenCalled();
  expect((await worker.fetch(request("/api/setup/not-a-route"), noBindings)).status).toBe(401);
});

it("preserves the order of auth, policies, metadata, and the fallbacks it can reach", async () => {
  const spies = {
    access: vi.spyOn(access, "withVerifiedAccessIdentity"),
    authorized: vi.spyOn(auth, "isAuthorizedRequest"),
    member: vi.spyOn(member, "enforceTeamMemberApiPolicy"),
    employee: vi.spyOn(employee, "enforceEmployeeRouteAccess"),
    metadata: vi.spyOn(metadata, "handleMeta"),
    model: vi.spyOn(model, "ensureLiveCodingModel"),
    sandbox: vi.spyOn(sandbox, "proxyToSandbox"),
    agent: vi.mocked(routeAgentRequest),
  };
  const order = () => Object.entries(spies)
    .flatMap(([name, spy]) => spy.mock.invocationCallOrder.map((index) => ({ name, index })))
    .sort((a, b) => a.index - b.index)
    .map(({ name }) => name);
  const clear = () => { for (const spy of Object.values(spies)) spy.mockClear(); };
  expect((await worker.fetch(request("/api/health", { method: "POST" }), noBindings)).status).toBe(401);
  expect(order()).toEqual(["access", "authorized"]);

  clear();
  const health = request("/api/health");
  expect((await worker.fetch(health, noBindings)).status).toBe(200);
  expect(order()).toEqual(["access", "member", "employee", "metadata"]);
  expect(spies.metadata).toHaveBeenCalledExactlyOnceWith(health, noBindings);

  clear();
  const miss = new Request("http://localhost/api/setup/not-a-route");
  expect((await worker.fetch(miss, noBindings)).status).toBe(404);
  expect(order()).toEqual(["access", "authorized", "member", "employee", "metadata", "model", "sandbox", "agent"]);

  clear();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const waitUntil = vi.fn();
  spies.metadata.mockRejectedValueOnce(new Error(`fixture-only ghp_${"x".repeat(36)}`));
  const failed = await worker.fetch(health, noBindings, { waitUntil } as unknown as ExecutionContext);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: "Internal error." });
  expect(order()).toEqual(["access", "member", "employee", "metadata"]);
  expect(waitUntil).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledOnce();
  const logged = errors.mock.calls[0]?.[0];
  expect(String(logged)).not.toContain("ghp_");
  expect(JSON.parse(String(logged))).toMatchObject({ level: "error", msg: "fixture-only [redacted]" });
});
