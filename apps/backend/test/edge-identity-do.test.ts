import { describe, expect, it, vi } from "vitest";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { signInternalRequest } from "../src/edge-identity.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  keepAliveWhile: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(),
  execute: vi.fn(async () => ({})),
  postSlackMessage: vi.fn(async () => ({})),
  postSlackMessageWithReceipt: vi.fn(async () => ({ channel: "C1", ts: "111.222" })),
  destroy: vi.fn(async () => undefined),
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
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/slack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/slack.js")>()),
  postSlackMessage: mocks.postSlackMessage,
  postSlackMessageWithReceipt: mocks.postSlackMessageWithReceipt,
}));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const KEY = "test-signing-secret-0123456789abcd";

function agent(keyed: boolean, strict = false): CodingOrchestrator {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: {
      ...productionEnvStubs(),
      Sandbox: {},
      INTERNAL_SIGNING_KEY: keyed ? KEY : undefined,
      SHIBA_LEGACY_SIGNING_FALLBACK: strict ? "0" : "1",
    },
    name: "edge-identity-test",
    ctx: { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) },
    state: { runs: [] } as OrchestratorState,
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      setStateLikeProduction(this, next);
    },
  });
}

describe("edge identity — DO consumer", () => {
  it("rejects a forged vouched header when INTERNAL_SIGNING_KEY is set", async () => {
    const req = new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", [AGENT_PRINCIPAL_HEADER]: "forged-agent" },
      body: JSON.stringify({ task: "forge a run" }),
    });
    const res = await agent(true).onRequest(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing_signature");
  });

  it.each([true, false])("explains missing signing configuration in a strict 401 (vouched=%s)", async (vouched) => {
    const instance = agent(false, true);
    const req = new Request("https://internal/internal/sweep-drafts", {
      method: "POST",
      headers: vouched ? { [AGENT_PRINCIPAL_HEADER]: "agent-alpha" } : {},
    });
    const res = await instance.onRequest(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Internal signature verification failed (INTERNAL_SIGNING_KEY not set).",
    });
  });

  it("accepts a properly signed vouched request when keyed", async () => {
    const req = new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", [AGENT_PRINCIPAL_HEADER]: "agent-alpha" },
      body: JSON.stringify({ task: "signed run" }),
    });
    await signInternalRequest(req, { INTERNAL_SIGNING_KEY: KEY });
    const res = await agent(true).onRequest(req);
    expect(res.status).not.toBe(401);
  });

  it("keeps header-trust behavior when the key is unset", async () => {
    const req = new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", [AGENT_PRINCIPAL_HEADER]: "agent-alpha" },
      body: JSON.stringify({ task: "unsigned run" }),
    });
    const res = await agent(false).onRequest(req);
    expect(res.status).not.toBe(401);
  });

  it("lets unvouched internal posts through unverified when keyed", async () => {
    const req = new Request("https://internal/internal/sweep-drafts", { method: "POST" });
    const res = await agent(true).onRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects a signed-then-tampered intake voucher", async () => {
    const req = new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", [LOCAL_INTAKE_HEADER]: "dashboard" },
      body: JSON.stringify({ task: "tampered intake" }),
    });
    await signInternalRequest(req, { INTERNAL_SIGNING_KEY: KEY });
    req.headers.set(LOCAL_INTAKE_HEADER, "forged-lane");
    const res = await agent(true).onRequest(req);
    expect(res.status).toBe(401);
  });
});
