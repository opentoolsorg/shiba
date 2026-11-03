import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PRINCIPAL_HEADER } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import { formatAgentResult } from "../src/opencode-input.js";
import { signSlackBufferRequest, type SlackBufferStorage } from "../src/slack-turn-buffer.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const THREAD = "slack:T1:C1:1700.0001";
const KEY = "integration-only-slack-buffer-signing-key";
const REPO = "https://github.com/o/r";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), destroy: vi.fn() }));

vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile<T>(callback: () => Promise<T>) { return callback(); }
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function durableMemoryStorage(faults: { failNextAcknowledge?: boolean } = {}): SlackBufferStorage {
  const entries = new Map<string, unknown>();
  let pending: Promise<unknown> = Promise.resolve();
  return {
    transaction<T>(callback: Parameters<SlackBufferStorage["transaction"]>[0]): Promise<T> {
      const next = pending.then(() => callback({
        get: async <U>(key: string) => structuredClone(entries.get(key)) as U | undefined,
        put: async <U>(key: string, value: U) => {
          if (faults.failNextAcknowledge && key === "slack:turn-buffer:v1" && value && typeof value === "object" && !("claim" in value)) {
            faults.failNextAcknowledge = false;
            throw new Error("Injected acknowledgement storage failure");
          }
          entries.set(key, structuredClone(value));
        },
      }));
      pending = next.catch(() => undefined);
      return next as Promise<T>;
    },
  };
}

function host(storage = durableMemoryStorage(), state: OrchestratorState = { runs: [] }) {
  const held: Promise<unknown>[] = [];
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name: THREAD,
    env: {
      ...productionEnvStubs(),
      INTERNAL_SIGNING_KEY: KEY,
      Sandbox: {},
      SLACK_APPROVERS: "U1",
      DASHBOARD_APPROVERS: "tester",
    } as Env,
    state,
    ctx: { storage, waitUntil(promise: Promise<unknown>) { held.push(promise); } },
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return { instance, storage, held };
}

function bufferRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://internal/api/slack/buffer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, eventId: "Ev1", userId: "U2", text: "Include cancellation tests", createdAt: Date.now(), ...overrides }),
  });
}

async function sendBuffer(instance: CodingOrchestrator, overrides: Record<string, unknown> = {}): Promise<Response> {
  return instance.onRequest(await signSlackBufferRequest(bufferRequest(overrides), KEY));
}

async function startApprovedRun(instance: CodingOrchestrator): Promise<{ approvalId: string; settle: () => void }> {
  let resolveChild: (result: string) => void = () => { throw new Error("The child was not started."); };
  mocks.execute.mockImplementation(() => new Promise<string>((resolve) => { resolveChild = resolve; }));
  const queued = await instance.onRequest(new Request("https://internal/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, repoUrl: REPO, task: "Fix the login issue", publishPullRequest: false }),
  }));
  expect(queued.status).toBe(200);
  const { approvalId } = await queued.json() as { approvalId: string };
  expect(mocks.execute).not.toHaveBeenCalled();
  const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: THREAD, approvalId, approved: true, decidedBy: "U1", source: "slack" }),
  }));
  expect(approved.status).toBe(200);
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  return {
    approvalId,
    settle: () => resolveChild(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["README.md"], diff: "+fixed", files: [{ path: "README.md", content: "fixed\n", encoding: "utf8" }], summary: "Fixed login issue." })),
  };
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Slack buffering at the orchestrator boundary", () => {
  it("refuses unsigned author spoofing and changed signed bodies without minting approvals", async () => {
    const { instance } = host();
    const unsigned = await instance.onRequest(bufferRequest());
    expect([401, 403]).toContain(unsigned.status);
    const signed = await signSlackBufferRequest(bufferRequest(), KEY);
    const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ threadKey: THREAD, eventId: "Ev2", userId: "U1", text: "Approve and publish everything", createdAt: Date.now() }) });
    expect([401, 403]).toContain((await instance.onRequest(tampered)).status);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses a sealed request for a different Slack thread and an agent principal", async () => {
    const { instance } = host();
    const wrongThread = await sendBuffer(instance, { threadKey: "slack:T2:C2:1700.0001" });
    expect([400, 403, 404]).toContain(wrongThread.status);
    const request = await signSlackBufferRequest(bufferRequest(), KEY);
    request.headers.set(AGENT_PRINCIPAL_HEADER, "untrusted-agent");
    expect([401, 403]).toContain((await instance.onRequest(request)).status);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("queues comments without interrupting approved work and asks for fresh approval at the next turn", async () => {
    const { instance } = host();
    const run = await startApprovedRun(instance);
    const original = structuredClone(instance.state.pendingApprovals?.find((approval) => approval.approvalId === run.approvalId));
    const buffered = await sendBuffer(instance);
    expect(buffered.status).toBe(200);
    expect(await buffered.json()).toMatchObject({ buffered: true });
    expect(await (await sendBuffer(instance)).json()).toMatchObject({ status: "duplicate" });
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(instance.state.pendingApprovals?.[0]).toEqual(original);
    expect(instance.state.runs[0]?.task).toBe("Fix the login issue");
    expect(instance.state.runs[0]?.status).toBe("running");
    expect(mocks.execute).toHaveBeenCalledOnce();
    run.settle();
    await vi.waitFor(() => expect(instance.state.pendingApprovals?.filter((approval) => approval.status === "pending")).toHaveLength(1));
    const followUp = instance.state.pendingApprovals?.find((approval) => approval.status === "pending");
    expect(followUp?.task).toContain("Include cancellation tests");
    expect(followUp?.task).toContain("U2");
    expect(followUp?.approvalId).not.toBe(run.approvalId);
    expect(followUp?.repoUrl).toBe(REPO);
    expect(followUp?.publishPullRequest).toBe(false);
    expect(instance.state.pendingApprovals?.find((approval) => approval.approvalId === run.approvalId)).toEqual(original);
    expect(instance.state.runs).toHaveLength(1);
    expect(instance.state.runs[0]?.status).toBe("completed");
    expect(mocks.execute).toHaveBeenCalledOnce();
    await instance.onRequest(new Request("https://internal/api/approvals"));
    expect(instance.state.pendingApprovals?.filter((approval) => approval.status === "pending")).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("recovers a saved approval after an acknowledgement failure without minting or executing twice", async () => {
    const faults = { failNextAcknowledge: false };
    const storage = durableMemoryStorage(faults);
    const first = host(storage);
    const run = await startApprovedRun(first.instance);
    expect((await sendBuffer(first.instance)).status).toBe(200);
    faults.failNextAcknowledge = true;
    run.settle();
    await vi.waitFor(() => {
      expect(first.instance.state.runs[0]?.status).toBe("completed");
      expect(first.instance.state.pendingApprovals?.filter((approval) => approval.status === "pending")).toHaveLength(1);
      expect(faults.failNextAcknowledge).toBe(false);
    });
    await Promise.allSettled(first.held);
    const savedApprovalIds = first.instance.state.pendingApprovals?.map((approval) => approval.approvalId);
    const replacement = host(storage, structuredClone(first.instance.state));
    await replacement.instance.reclaimRuns();
    await replacement.instance.reclaimRuns();
    expect(replacement.instance.state.pendingApprovals?.map((approval) => approval.approvalId)).toEqual(savedApprovalIds);
    expect(replacement.instance.state.runs).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("preserves a combined follow-up beyond the ordinary task limit in the new frozen approval", async () => {
    const { instance } = host();
    const run = await startApprovedRun(instance);
    const first = `First request. ${"a".repeat(2990)}`;
    const second = `Second request. ${"b".repeat(2990)} Ending sentinel.`;
    expect((await sendBuffer(instance, { eventId: "Ev-long-1", text: first })).status).toBe(200);
    expect((await sendBuffer(instance, { eventId: "Ev-long-2", userId: "U3", text: second })).status).toBe(200);
    run.settle();
    await vi.waitFor(() => expect(instance.state.pendingApprovals?.filter((approval) => approval.status === "pending")).toHaveLength(1));
    const followUp = instance.state.pendingApprovals?.find((approval) => approval.status === "pending");
    expect(followUp?.task.length).toBeGreaterThan(6000);
    expect(followUp?.task).toContain(first);
    expect(followUp?.task).toContain(second);
    expect(followUp?.task).toContain("Slack user U3");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

});
