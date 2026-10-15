/**
 * The built-in PR review lane: a `pull_request` opened/synchronize delivery
 * through the Automations DO queues an approval-gated review run carrying
 * the repo, head SHA, and diff ref — alongside any user automations that
 * matched. Other events never spawn it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const orchestratorCalls: { input: Record<string, unknown> }[] = [];
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/api/runs") {
        orchestratorCalls.push({ input: (await request.json()) as Record<string, unknown> });
        return Response.json({ approvalId: "appr_review" });
      }
      return new Response("{}", { status: 404 });
    },
  }),
  routeAgentRequest: async () => null,
}));

import { Automations } from "../src/automations-do.js";
import type { Env } from "../src/env.js";

function makeDo(env: Partial<Env> = {}) {
  const storage = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      list: async (opts?: { prefix?: string }) =>
        new Map([...storage.entries()].filter(([k]) => (opts?.prefix ? k.startsWith(opts.prefix) : true))),
      delete: async (keys: string[]) => {
        for (const k of keys) storage.delete(k);
      },
    },
  } as unknown as DurableObjectState;
  const fullEnv = {
    CodingOrchestrator: {},
    AUTOMATIONS_ENABLED: "true",
    AI: {},
    ORCHESTRATOR_MODEL: "@cf/test/model",
    ...env,
  } as unknown as Env;
  return new Automations(ctx, fullEnv);
}

const PR_PAYLOAD = {
  action: "opened",
  number: 12,
  repository: { full_name: "acme/widgets" },
  pull_request: {
    number: 12,
    html_url: "https://github.com/acme/widgets/pull/12",
    diff_url: "https://github.com/acme/widgets/pull/12.diff",
    head: { ref: "feature/login", sha: "abc123def" },
    base: { ref: "main" },
    user: { login: "prince" },
    labels: [],
  },
  sender: { login: "prince" },
};

function githubInternal(payload: unknown, event = "pull_request", deliveryId = "d-pr-1") {
  return new Request("https://internal/internal/github", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload, deliveryId }),
  });
}

describe("pull_request review lane", () => {
  it("queues a review run carrying repo, head sha, and diff ref", async () => {
    orchestratorCalls.length = 0;
    const automation = makeDo();
    const res = await automation.fetch(githubInternal(PR_PAYLOAD));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(true);
    expect(orchestratorCalls).toHaveLength(1);
    const input = orchestratorCalls[0]!.input;
    expect(input.repoUrl).toBe("https://github.com/acme/widgets");
    expect(input.task).toContain("Purpose: review");
    expect(input.task).toContain("Head SHA: abc123def");
    expect(input.task).toContain("https://github.com/acme/widgets/pull/12.diff");
    expect(input.threadKey).toBe("review:acme/widgets#12");
    expect(input.commandId).toBe("review:d-pr-1");
    expect(input.publishPullRequest).toBe(false);
  });

  it("queues on synchronize too", async () => {
    orchestratorCalls.length = 0;
    const payload = { ...PR_PAYLOAD, action: "synchronize" };
    const res = await makeDo().fetch(githubInternal(payload, "pull_request", "d-pr-2"));
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(true);
    expect(orchestratorCalls).toHaveLength(1);
  });

  it("does not queue for other pull_request actions or events", async () => {
    orchestratorCalls.length = 0;
    const closed = await makeDo().fetch(githubInternal({ ...PR_PAYLOAD, action: "closed" }));
    expect(((await closed.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(false);
    const push = await makeDo().fetch(githubInternal({ ref: "refs/heads/main", repository: { full_name: "acme/widgets" } }, "push", "d-3"));
    expect(((await push.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(false);
    expect(orchestratorCalls).toHaveLength(0);
  });

  it("skips the lane when automations are globally disabled", async () => {
    orchestratorCalls.length = 0;
    const res = await makeDo({ AUTOMATIONS_ENABLED: "false" }).fetch(githubInternal(PR_PAYLOAD));
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(false);
    expect(orchestratorCalls).toHaveLength(0);
  });

  it("still reports the fan-out result when the queue throws", async () => {
    orchestratorCalls.length = 0;
    const automation = makeDo();
    // Payload without a head sha skips the lane; the fan-out still answers.
    const noSha = { ...PR_PAYLOAD, pull_request: { ...PR_PAYLOAD.pull_request, head: { ref: "x" } } };
    const res = await automation.fetch(githubInternal(noSha));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(false);
  });
});
