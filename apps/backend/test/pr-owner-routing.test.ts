/**
 * PR owner index: webhook pr-lifecycle routes to the owning orchestrator DO;
 * built-in review lane stays on default only when unowned; one intent per head SHA.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { prOwnerStorageKey } from "@shiba/shared";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
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

const lifecycleCalls: Array<{ agentName: string }> = [];
const queueCalls: Array<{ agentName: string }> = [];
let queueShouldFail = false;
let lifecycleShouldFail = false;
let lifecycleOmitsQueuedReview = false;

vi.mock("agents/routing", () => ({
  getAgentByName: async (_env: unknown, name: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/internal/pr-lifecycle") {
        lifecycleCalls.push({ agentName: name });
        if (lifecycleShouldFail) {
          return Response.json({ error: "lifecycle_down" }, { status: 503 });
        }
        return Response.json(
          lifecycleOmitsQueuedReview
            ? { ok: true, wake: "synchronize_re_review" }
            : { ok: true, wake: "synchronize_re_review", queued: "review" },
        );
      }
      if (path === "/api/runs") {
        queueCalls.push({ agentName: name });
        if (queueShouldFail) {
          return Response.json({ error: "queue_down" }, { status: 503 });
        }
        return Response.json({ approvalId: "appr_review" });
      }
      return new Response("{}", { status: 404 });
    },
  }),
  routeAgentRequest: async () => null,
}));

import { Automations } from "../src/automations-do.js";
import type { Env } from "../src/env.js";

function makeDo(storage: Map<string, unknown>, env: Partial<Env> = {}) {
  const storageApi = {
    get: async (key: string) => storage.get(key),
    put: async (key: string, value: unknown) => void storage.set(key, value),
    list: async (opts?: { prefix?: string }) =>
      new Map([...storage.entries()].filter(([k]) => (opts?.prefix ? k.startsWith(opts.prefix) : true))),
    delete: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) storage.delete(k);
    },
  };
  const ctx = {
    storage: {
      ...storageApi,
      transaction: async (callback: (transaction: typeof storageApi) => Promise<unknown>) => callback(storageApi),
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

const SYNC_PAYLOAD = {
  action: "synchronize",
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

function githubInternal(payload: unknown, deliveryId = "d-sync-1") {
  return new Request("https://internal/internal/github", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "pull_request", payload, deliveryId }),
  });
}

describe("PR owner routing", () => {
  beforeEach(() => {
    lifecycleCalls.length = 0;
    queueCalls.length = 0;
    queueShouldFail = false;
    lifecycleShouldFail = false;
    lifecycleOmitsQueuedReview = false;
  });

  it("routes synchronize re-review to the owning non-default orchestrator DO", async () => {
    const storage = new Map<string, unknown>();
    storage.set(prOwnerStorageKey("acme/widgets", 12), {
      agentName: "user-alice:session-7",
      codingRunId: "run-dashboard-1",
      updatedAt: Date.now(),
    });
    const automation = makeDo(storage);
    const res = await automation.fetch(githubInternal(SYNC_PAYLOAD));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(true);
    expect(lifecycleCalls).toEqual([{ agentName: "user-alice:session-7" }]);
    expect(queueCalls).toHaveLength(0);
  });

  it("uses the built-in review lane on default when no owner is indexed", async () => {
    const automation = makeDo(new Map());
    const res = await automation.fetch(githubInternal(SYNC_PAYLOAD, "d-sync-2"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(true);
    expect(lifecycleCalls).toEqual([{ agentName: "default" }]);
    expect(queueCalls).toEqual([{ agentName: "default" }]);
  });

  it("releases the head claim when the built-in review lane fails so GitHub can retry", async () => {
    lifecycleOmitsQueuedReview = true;
    queueShouldFail = true;
    const automation = makeDo(new Map());
    const first = await automation.fetch(githubInternal(SYNC_PAYLOAD, "d-fail-1"));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(false);

    queueShouldFail = false;
    lifecycleCalls.length = 0;
    queueCalls.length = 0;
    const second = await automation.fetch(githubInternal(SYNC_PAYLOAD, "d-fail-2"));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { reviewQueued?: boolean }).reviewQueued).toBe(true);
    expect(lifecycleCalls).toHaveLength(1);
    expect(queueCalls).toHaveLength(1);
  });

  it("dedupes a second delivery for the same head SHA", async () => {
    const storage = new Map<string, unknown>();
    storage.set(prOwnerStorageKey("acme/widgets", 12), {
      agentName: "user-alice:session-7",
      codingRunId: "run-dashboard-1",
      updatedAt: Date.now(),
    });
    const automation = makeDo(storage);
    await automation.fetch(githubInternal(SYNC_PAYLOAD, "d-sync-a"));
    await automation.fetch(githubInternal(SYNC_PAYLOAD, "d-sync-b"));
    expect(lifecycleCalls).toHaveLength(1);
    expect(queueCalls).toHaveLength(0);
  });
});
