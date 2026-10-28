import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInputHash, type CustomAgentRecord } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { formatAgentResult, parseAgentToolInput } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { createRun } from "../src/runs.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), resolveCustom: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  getTools() { return {}; }
  keepAliveWhile<T>(run: () => Promise<T>) { return run(); }
  async schedule() { return {}; }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/custom-agents-resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/custom-agents-resolve.js")>(),
  resolveCustomAgentForRun: mocks.resolveCustom,
}));

const INPUT = { repoUrl: "https://github.com/o/r", task: "Fix the parser", baseBranch: "main", publishPullRequest: false, customAgentId: "bot-1" };
const PROFILE: CustomAgentRecord = {
  id: "bot-1", orgId: "self-hosted", slug: "parser-bot", version: 1, createdAt: 1, updatedAt: 1,
  config: { name: "Parser bot", instructions: "Check edge cases", harness: "opencode", sandboxProvider: "cloudflare", approvalPolicy: "auto_approve" },
};
function fixture(storage = true) {
  const resolveApproval = vi.fn(async () => Response.json({ ok: true }));
  const statement = {
    bind: (..._values: unknown[]) => statement,
    run: async () => ({ success: true }),
    first: async () => null,
  };
  const env = { ...productionEnvStubs(), Sandbox: {}, ...(storage ? { AGENT_AUDIT: { prepare: () => statement } } : {}) } as unknown as Env;
  const instance: CodingOrchestrator = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env,
    state: { runs: [] } as OrchestratorState,
    resolveApproval,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  const queue = (extra: Record<string, unknown> = {}) => instance.onRequest(new Request("https://internal/api/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...INPUT, ...extra }),
  }));
  const gate = () => (instance.getTools().delegate_coding_task as unknown as {
    needsApproval(input: unknown, options: { toolCallId: string }): Promise<boolean>;
  }).needsApproval(INPUT, { toolCallId: "chat-bot" });
  return { instance, env, queue, gate, resolveApproval };
}

beforeEach(() => { vi.resetAllMocks(); mocks.resolveCustom.mockResolvedValue(PROFILE); });
setSandboxHandleResolver(() => ({ destroy: async () => undefined }));

describe("custom agent frozen-input approval boundary", () => {
  it("keeps a legacy auto_approve profile pending for human review on HTTP intake", async () => {
    const f = fixture();
    const response = await f.queue();
    expect(response.status).toBe(200);
    expect(f.resolveApproval).not.toHaveBeenCalled();
    expect(f.instance.state.pendingApprovals).toEqual([expect.objectContaining({
      customAgentId: PROFILE.id, status: "pending", task: "Check edge cases\n\n---\n\nFix the parser",
    })]);
    expect(await response.json()).not.toHaveProperty("autoApproved");
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the same profile approval-gated on chat intake", async () => {
    const f = fixture();
    await expect(f.gate()).resolves.toBe(true);
    expect(f.instance.state.pendingApprovals?.[0]).toMatchObject({ customAgentId: PROFILE.id, status: "pending" });
    expect(f.resolveApproval).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not silently replace a missing chat profile with a generic agent", async () => {
    mocks.resolveCustom.mockResolvedValue(null);
    const f = fixture();
    await expect(f.gate()).rejects.toThrow("Bot not found");
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses profile-selected chat intake when profile storage is unavailable", async () => {
    const f = fixture(false);
    await expect(f.gate()).rejects.toThrow("Bot storage is not configured");
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("refuses profile-selected HTTP intake when profile storage is unavailable", async () => {
    const f = fixture(false);
    expect((await f.queue()).status).toBe(503);
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
  });

  it("preflights the profile's provider instead of an incompatible deployment default", async () => {
    const f = fixture();
    f.env.SHIBA_SANDBOX_PROVIDER = "e2b";
    expect((await f.queue()).status).toBe(200);
    expect(f.instance.state.pendingApprovals?.[0]).toMatchObject({ sandboxProvider: "cloudflare", status: "pending" });
    const chat = fixture();
    chat.env.SHIBA_SANDBOX_PROVIDER = "e2b";
    await expect(chat.gate()).resolves.toBe(true);
    expect(chat.instance.state.pendingApprovals?.[0]).toMatchObject({ sandboxProvider: "cloudflare", status: "pending" });
  });

  it("rejects an unsupported selected sandbox provider before presenting a chat approval", async () => {
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, sandboxProvider: "e2b" } });
    const f = fixture();
    await expect(f.gate()).rejects.toThrow(/e2b|egress|capabilit/i);
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping queue retries after asynchronous model preflight", async () => {
    let releasePreflight!: () => void;
    const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let bothWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { bothWaiting = resolve; });
    let reads = 0;
    const f = fixture(false);
    f.env.ModelConfig = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => {
        reads += 1;
        // Each request reads connections and policy before intake can mint.
        if (reads === 4) bothWaiting();
        await preflight;
        return Response.json({});
      } }),
    } as unknown as Env["ModelConfig"];
    const first = f.queue({ commandId: "same-request", customAgentId: undefined });
    const retry = f.queue({ commandId: "same-request", customAgentId: undefined });
    await waiting;
    releasePreflight();
    const responses = await Promise.all([first, retry]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{ approvalId: string; deduped?: boolean }>;
    expect(bodies[0]?.approvalId).toBe(bodies[1]?.approvalId);
    expect(bodies.filter((body) => body.deduped)).toHaveLength(1);
    expect(f.instance.state.pendingApprovals).toHaveLength(1);
    expect(Object.values(f.instance.state.commandReceipts ?? {}).filter((receipt) => receipt.commandId === "queue:same-request")).toHaveLength(1);
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["http", "chat"])("freezes profile v1 through %s approval, execution, and result after a v2 edit", async (surface) => {
    const f = fixture();
    Reflect.deleteProperty(f.instance, "resolveApproval");
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Parser fixed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [],
    }));
    if (surface === "http") await f.queue({ customAgentVersion: 999 });
    else await f.gate();
    const pointer = f.instance.state.pendingApprovals?.[0];
    expect(pointer).toMatchObject({ customAgentId: PROFILE.id, customAgentVersion: 1, status: "pending" });
    const frozenTask = pointer!.task;
    const frozenRoute = pointer!.route;
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, version: 2, config: {
      ...PROFILE.config, instructions: "Changed instructions", harness: "claude-code", codingModel: "anthropic/claude-sonnet-5-5",
    } });
    const response = await f.instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: pointer!.approvalId, threadKey: pointer!.threadKey, approved: true, decidedBy: "human" }),
    }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(f.instance.state.runs[0]?.status).toBe("completed"));
    expect(f.instance.state.runs[0]).toMatchObject({ customAgentId: PROFILE.id, customAgentVersion: 1,
      task: frozenTask, route: frozenRoute, sandboxProvider: "cloudflare", status: "completed" });
    const dispatched = parseAgentToolInput([{ role: "user", text: String(mocks.execute.mock.calls[0]?.[0]) }]);
    expect(dispatched).toMatchObject({ customAgentId: PROFILE.id, customAgentVersion: 1, task: frozenTask,
      codingModel: frozenRoute!.modelId, harness: "opencode", sandboxProvider: "cloudflare" });
    expect(dispatched.task).not.toContain("Changed instructions");
  });

  it.each(["http", "chat"])("freezes profile required paths through %s approval despite client removal and a v2 edit", async (surface) => {
    const f = fixture();
    Reflect.deleteProperty(f.instance, "resolveApproval");
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, expectedDeliverables: ["brief.md"] } });
    const metadata = { path: "brief.md", mediaType: "text/markdown; charset=utf-8", bytes: 12, sha256: "a".repeat(64) };
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", summary: "Draft captured", exitCode: 0, stderrTail: "", changedFiles: ["brief.md"], diff: "+draft", files: [], deliverables: [metadata],
    }));
    if (surface === "http") await f.queue({ expectedDeliverables: [] });
    else await f.gate();
    const pointer = f.instance.state.pendingApprovals![0]!;
    expect(pointer.expectedDeliverables).toEqual(["brief.md"]);
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, version: 2, config: { ...PROFILE.config, expectedDeliverables: ["replacement.md"] } });
    const response = await f.instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", body: JSON.stringify({ approvalId: pointer.approvalId, threadKey: pointer.threadKey, approved: true, decidedBy: "human" }),
    }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(f.instance.state.runs[0]?.status).toBe("completed"));
    const run = f.instance.state.runs[0]!;
    expect(run.expectedDeliverables).toEqual(["brief.md"]);
    expect(run.deliverables).toEqual([metadata]);
    expect(run.customAgentVersion).toBe(1);
    const dispatched = parseAgentToolInput([{ role: "user", text: String(mocks.execute.mock.calls[0]?.[0]) }]);
    expect(dispatched.expectedDeliverables).toEqual(["brief.md"]);
    expect(JSON.stringify(await (await f.instance.onRequest(new Request("https://internal/api/runs/"+encodeURIComponent(run.runId)))).json())).not.toContain('"content"');
  });

  it("does not attach a late stored deliverable manifest after the run was cancelled", async () => {
    const f = fixture(); Reflect.deleteProperty(f.instance, "resolveApproval");
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, expectedDeliverables: ["brief.md"] } });
    let finishChild!: (value: string) => void;
    const child = new Promise<string>((resolve) => { finishChild = resolve; });
    mocks.execute.mockReturnValue(child);
    await f.queue(); const pointer = f.instance.state.pendingApprovals![0]!;
    await f.instance.onRequest(new Request("https://internal/api/approvals", { method: "POST", body: JSON.stringify({ approvalId: pointer.approvalId, threadKey: pointer.threadKey, approved: true, decidedBy: "human" }) }));
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const runId = f.instance.state.runs[0]!.runId;
    await f.instance.cancelRun(runId);
    finishChild(formatAgentResult({ status: "completed", summary: "late stored draft", exitCode: 0, stderrTail: "", changedFiles: ["brief.md"], diff: "+draft", files: [], deliverables: [{ path: "brief.md", mediaType: "text/markdown; charset=utf-8", bytes: 12, sha256: "a".repeat(64) }] }));
    await child; await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.instance.state.runs[0]).toMatchObject({ status: "cancelled" });
    expect(f.instance.state.runs[0]?.deliverables).toBeUndefined();
  });

  it("fails a completed child claim when frozen required files have no stored manifest", async () => {
    const f = fixture(); Reflect.deleteProperty(f.instance, "resolveApproval");
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, expectedDeliverables: ["brief.md"] } });
    mocks.execute.mockResolvedValue(formatAgentResult({ status: "completed", summary: "claimed", exitCode: 0, stderrTail: "", changedFiles: ["brief.md"], diff: "+draft", files: [] }));
    await f.queue(); const pointer = f.instance.state.pendingApprovals![0]!;
    await f.instance.onRequest(new Request("https://internal/api/approvals", { method: "POST", body: JSON.stringify({ approvalId: pointer.approvalId, threadKey: pointer.threadKey, approved: true, decidedBy: "human" }) }));
    await vi.waitFor(() => expect(f.instance.state.runs[0]?.status).toBe("error"));
    expect(f.instance.state.runs[0]?.deliverables).toBeUndefined();
  });

  it.each(["archived", "deleted"])("does not approve a profile that became %s after queueing", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.instance, "resolveApproval");
    await f.queue();
    const pointer = f.instance.state.pendingApprovals![0]!;
    mocks.resolveCustom.mockResolvedValue(null);
    const response = await f.instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", body: JSON.stringify({ approvalId: pointer.approvalId, threadKey: pointer.threadKey, approved: true, decidedBy: "human" }),
    }));
    expect(response.status).toBe(409);
    expect(f.instance.state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects legacy nonempty tool scopes on HTTP and chat instead of running unrestricted", async () => {
    mocks.resolveCustom.mockResolvedValue({ ...PROFILE, config: { ...PROFILE.config, toolScopes: ["files:read"] } });
    const f = fixture();
    const response = await f.queue();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("toolScopes are not supported") });
    await expect(f.gate()).rejects.toThrow("toolScopes are not supported");
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("binds the resolved profile version and provider to approval evidence while preserving legacy hashes", () => {
    const input = { repoUrl: INPUT.repoUrl, task: INPUT.task, baseBranch: "main", publishPullRequest: false };
    expect(runInputHash({ ...input, customAgentVersion: undefined })).toBe(runInputHash(input));
    const frozen = { ...input, customAgentId: "bot-1", customAgentVersion: 1, sandboxProvider: "cloudflare" };
    const approval = { approvalId: "a1", decidedBy: "human", decidedAt: 1, inputHash: runInputHash(frozen) };
    expect(createRun({ ...frozen, runId: "r1", sandboxId: "s1", approval })).toMatchObject(frozen);
    expect(() => createRun({ ...frozen, customAgentVersion: 2, runId: "r2", sandboxId: "s2", approval })).toThrow("does not cover");
    expect(() => createRun({ ...frozen, sandboxProvider: "e2b", runId: "r3", sandboxId: "s3", approval })).toThrow("does not cover");
  });
});
