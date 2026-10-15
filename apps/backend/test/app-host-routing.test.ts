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
    for (const path of ["/", "/dashboard/", "/skills", "/settings/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe("/app/");
    }
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
