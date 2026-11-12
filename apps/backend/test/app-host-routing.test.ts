import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker, { DASHBOARD_VIEWS } from "../src/index.js";

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
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

// ASSETS echoes the path it was asked for, so a test sees which file the worker served.
const env = {
  ASSETS: { fetch: (request: Request) => Promise.resolve(new Response(new URL(request.url).pathname)) },
} as unknown as Env;

const get = (path: string) => worker.fetch(new Request(`https://app.tryshiba.dev${path}`), env);

describe("app host routing", () => {
  it("serves the dashboard shell for root view paths, signed out", async () => {
    for (const path of ["/", "/work", "/work/", "/dashboard/", "/skills", "/settings/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe("/app/");
    }
  });

  it.each(["/signin", "/signin/", "/login", "/login/"])("serves the static sign-in shell at %s without API authentication", async (path) => {
    const assets = { fetch: vi.fn(async () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })) };
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request(`https://app.tryshiba.dev${path}`, { method, headers: { accept: "text/html" } }), { ...env, ASSETS: assets } as unknown as Env);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html");
    }
  });

  it.each(["/api/employee-tools", "/api/employee-tools/unknown", "/api/custom-agents", "/api/custom-agents/id/unknown", "/api/spaces/unknown", "/api/skills/library/unknown", "/api/org/model-keys/unknown", "/api/reason-network/unknown"])("requires authentication before resolving org path %s", async (path) => {
    const response = await worker.fetch(new Request(`https://app.tryshiba.dev${path}`), { ...env, ACCESS_REQUIRED: "1", AGENT_AUDIT: {} } as unknown as Env);
    expect(response.status).toBe(401);
  });

  it.each(["/api/employee-tools", "/api/employee-tools/unknown", "/api/custom-agents", "/api/custom-agents/id/unknown", "/api/spaces", "/api/spaces/unknown", "/api/org/model-keys", "/api/org/model-keys/unknown", "/api/reason-network", "/api/reason-network/unknown"])("requires authentication even with missing bindings at %s", async (path) => {
    const response = await worker.fetch(new Request(`https://app.tryshiba.dev${path}`), { ...env, ACCESS_REQUIRED: "1" } as unknown as Env);
    expect(response.status).toBe(401);
  });

  it.each(["/api/github/webhook", "/api/sentry/webhook", "/api/slack/events", "/api/slack/command", "/api/slack/interact"])("keeps unset webhook secrets private at %s", async (path) => {
    const response = await worker.fetch(new Request(`https://app.tryshiba.dev${path}`, { method: "POST", body: "{}" }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Webhook is disabled." });
  });

  it("never decodes encoded path traversal into a dashboard route", async () => {
    const response = await get("/api/employee-tools/..%2fsignin");
    expect(await response.text()).not.toBe("/app/");
  });

  it("rejects guessed internal headers without touching storage", async () => {
    const bindings = { ...env, INTERNAL_SIGNING_KEY: "a".repeat(32) } as Env;
    Object.defineProperty(bindings, "AGENT_AUDIT", { get: () => { throw new Error("unauthorized storage access"); } });
    const response = await worker.fetch(new Request("https://app.tryshiba.dev/internal/founder-automatic-read/permit", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": "guessed", authorization: "Bearer guessed" }, body: JSON.stringify({ stage: "dispatch", capability: "forged.signature", requestDigest: "a".repeat(64) }) }), bindings);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden." });
  });

  it("sends marketing paths to tryshiba.dev", async () => {
    const res = await get("/docs/overview/?q=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://tryshiba.dev/docs/overview/?q=1");
  });

  it("keeps deeper /agents/* paths off the shell", async () => {
    const res = await get("/agents/coding-orchestrator/x");
    expect(await res.text()).not.toBe("/app/");
  });

  it("has a server path for every sidebar view", () => {
    const rail = readFileSync(join(__dirname, "../../frontend/src/components/AppNavRail.tsx"), "utf8");
    const ids = [...rail.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(DASHBOARD_VIEWS.has(id), id).toBe(true);
  });
});
