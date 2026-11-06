import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { BotReadinessCheck } from "../src/bot-readiness.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { createCustomAgent, setCustomAgentArchived } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ dashboard: true }));

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.dashboard),
  resolveUserId: vi.fn(async () => authState.dashboard ? "owner@example.test" : null),
}));

function env(overrides: Partial<Env> = {}): Env {
  return {
    AGENT_AUDIT: customAgentD1().database,
    SHIBA_SANDBOX_PROVIDER: "cloudflare",
    Sandbox: {} as unknown,
    AGENT_HARNESS: "opencode",
    GATEWAY_ID: "default",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    AI_GATEWAY_TOKEN: "gateway-token",
    ...overrides,
  } as Env;
}

const readiness = (bindings: Env, id: string, method = "GET") => handleCustomAgents(
  new Request(`https://x/api/custom-agents/${id}/readiness`, { method, headers: { origin: "https://x", "content-type": "application/json" } }),
  bindings,
);

beforeEach(() => { authState.dashboard = true; });

describe("bot launch readiness", () => {
  it("reports a ready repository bot with its default target and route", async () => {
    const bindings = env();
    const agent = await createCustomAgent(bindings, "self-hosted", "scout", {
      name: "Scout", instructions: "Read first.", harness: "opencode", defaultRepoUrl: "https://github.com/example/repo",
    });
    const response = await readiness(bindings, agent.id);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { readiness: Record<string, unknown> };
    expect(body.readiness).toMatchObject({
      ready: true,
      target: { kind: "repository", repoUrl: "https://github.com/example/repo" },
      harness: "opencode",
      model: "google/gemini-3.5-flash-lite",
      connectionId: null,
      synthetic: false,
    });
  });

  it("surfaces a missing AI_GATEWAY_TOKEN up front with a Providers fix link", async () => {
    const bindings = env({ AI_GATEWAY_TOKEN: "" });
    const agent = await createCustomAgent(bindings, "self-hosted", "writer", { name: "Writer", instructions: "Draft.", harness: "opencode" });
    const report = await new BotReadinessCheck(bindings, "self-hosted", agent).run();
    expect(report.ready).toBe(false);
    expect(report.problems).toContainEqual(expect.objectContaining({
      id: "gateway.token", severity: "error", fix: expect.objectContaining({ view: "providers" }),
    }));
  });

  it("flags a bot pinned to a model connection that no longer exists", async () => {
    const bindings = env();
    const agent = await createCustomAgent(bindings, "self-hosted", "pinned", {
      name: "Pinned", instructions: "Draft.", harness: "opencode", connectionId: "conn_missing",
    });
    const report = await new BotReadinessCheck(bindings, "self-hosted", agent).run();
    expect(report.ready).toBe(false);
    expect(report.problems[0]?.fix.view).toBe("providers");
  });

  it("treats a bot without a repository as an artifact-workspace bot", async () => {
    const bindings = env();
    const agent = await createCustomAgent(bindings, "self-hosted", "analyst", {
      name: "Analyst", instructions: "Summarise.", harness: "opencode", expectedDeliverables: ["deliverables/report.md"],
    });
    const report = await new BotReadinessCheck(bindings, "self-hosted", agent).run();
    expect(report.target).toEqual({ kind: "artifact-workspace", expectedDeliverables: ["deliverables/report.md"] });
    expect(report.problems.some((problem) => problem.id === "github.credentials")).toBe(false);
    expect(report.ready).toBe(true);
  });

  it("labels stand-in deployments as synthetic", async () => {
    const bindings = env({ SHIBA_VERIFY_STANDIN: "1", GITHUB_API_BASE: "http://127.0.0.1:8799" } as Partial<Env>);
    const agent = await createCustomAgent(bindings, "self-hosted", "standin", { name: "Standin", instructions: "x", harness: "opencode" });
    expect((await new BotReadinessCheck(bindings, "self-hosted", agent).run()).synthetic).toBe(true);
  });

  it("is GET-only, refuses archived bots, and never creates approvals", async () => {
    const bindings = env();
    const agent = await createCustomAgent(bindings, "self-hosted", "old", { name: "Old", instructions: "x", harness: "opencode" });
    expect((await readiness(bindings, agent.id, "POST"))?.status).toBe(405);
    await setCustomAgentArchived(bindings, "self-hosted", agent.id, true);
    expect((await readiness(bindings, agent.id))?.status).toBe(404);
  });

  it("requires dashboard or API authentication", async () => {
    authState.dashboard = false;
    const bindings = env();
    const agent = await createCustomAgent(bindings, "self-hosted", "private", { name: "Private", instructions: "x", harness: "opencode" });
    expect((await readiness(bindings, agent.id))?.status).toBe(401);
  });
});
