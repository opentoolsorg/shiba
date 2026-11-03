import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_DEADLINE_MS, type ApprovedRoute } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { sealChildDispatch } from "../src/child-dispatch.js";
import { formatAgentResult, parseAgentToolInput, type CodingTaskInput } from "../src/opencode-input.js";
import { parentRecoveryKey, validateParentExecutionRecovery, type ParentExecutionRecovery } from "../src/parent-execution-recovery.js";
import { makeSandboxId } from "../src/security.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { approveDirect } from "./seeding.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), destroy: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  schedule() { return Promise.resolve({}); }
  keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const ROUTE: ApprovedRoute = { purpose: "coding", connectionId: null, harness: "opencode", modelId: "google/gemini-3.5-flash-lite", policyVersion: 0 };
const INPUT = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, runtime: "sandbox" as const, route: ROUTE };
const OUTPUT = formatAgentResult({ status: "completed", exitCode: 0, summary: "Recovered once.", stderrTail: "", changedFiles: [], files: [], diff: "" });

function host(records = new Map<string, unknown>()) {
  const held: Promise<unknown>[] = [];
  const storage = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    delete: async (key: string) => records.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
  };
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {} }, name: "default", messages: [], state: { runs: [] } as OrchestratorState,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
    ctx: { storage, waitUntil(promise: Promise<unknown>) { held.push(promise); } },
    hasAgentToolRun: vi.fn(() => true),
    subAgent: vi.fn(async () => ({ inspectExecutionRecovery: inspect })),
    runAgentTool: vi.fn(async (_class: unknown, _options: { runId: string; input: unknown }) => ({ status: "completed", summary: OUTPUT })),
    cancelAgentTool: vi.fn(async () => undefined),
  });
  const inspect = vi.fn(async (input: CodingTaskInput) => ({ phase: "harness", envelopeHash: input.dispatchEnvelopeHash, expiresAt: input.dispatchExpiresAt }));
  return { instance, records, held, inspect, storage };
}

async function fixture(now = Date.now()) {
  const context = host();
  approveDirect(context.instance, "recover", INPUT);
  const run = context.instance.state.runs[0]!;
  run.sandboxId = makeSandboxId(run.repoUrl, run.task, "recover");
  run.status = "running";
  run.checkpoint = "executing";
  run.generation = 1;
  run.resumeAttemptedAt = now;
  const input: CodingTaskInput = {
    ...INPUT, sandboxId: run.sandboxId, accessAgent: "default", approvalThreadKey: "default", codingModel: ROUTE.modelId, harness: "opencode",
  };
  Object.assign(input, await sealChildDispatch(context.instance.env, {
    approvalId: "recover", sandboxId: input.sandboxId, inputHash: run.approval!.inputHash,
  }, input, now));
  const snapshot: ParentExecutionRecovery = { version: 1, owner: "default", generation: 1, toolCallId: "recover", input };
  context.records.set(parentRecoveryKey(run.runId), snapshot);
  return { ...context, run, snapshot };
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });

describe("private parent execution snapshot", () => {
  it("validates an exact signed snapshot without extending its expiry", async () => {
    const { instance, run, snapshot } = await fixture();
    const validated = await validateParentExecutionRecovery(instance.env, "default", run, snapshot);
    expect(validated?.input.dispatchExpiresAt).toBe(snapshot.input.dispatchExpiresAt);
  });

  it.each(["generation", "owner", "task", "approval", "sandbox", "route", "expiry", "settling", "local", "missing"])("rejects %s changes", async (change) => {
    const { instance, run, snapshot } = await fixture();
    const copy = structuredClone(snapshot);
    const actual = structuredClone(run);
    if (change === "generation") actual.generation++;
    if (change === "owner") copy.owner = "other";
    if (change === "task") copy.input.task = "changed";
    if (change === "approval") actual.approval!.inputHash = "b".repeat(64);
    if (change === "sandbox") copy.input.sandboxId = "other";
    if (change === "route") copy.input.route!.modelId = "changed";
    if (change === "expiry") copy.input.dispatchExpiresAt = Date.now() - 1;
    if (change === "settling") actual.checkpoint = "settling";
    if (change === "local") copy.input.runtime = "local";
    expect(await validateParentExecutionRecovery(instance.env, "default", actual, change === "missing" ? null : copy)).toBeNull();
  });
});

describe("orchestrator eviction attachment", () => {
  it("commits the exact sealed envelope privately before the first child dispatch", async () => {
    const { instance, records } = host();
    approveDirect(instance, "fresh", INPUT);
    instance.state.runs[0]!.sandboxId = makeSandboxId(INPUT.repoUrl, INPUT.task, "fresh");
    let captured: ParentExecutionRecovery | undefined;
    mocks.execute.mockImplementation(async (text: string) => {
      captured = records.get(parentRecoveryKey("agent-tool:fresh")) as ParentExecutionRecovery;
      expect(captured).toBeDefined();
      expect(captured.input).toEqual(parseAgentToolInput([{ role: "user", text }]));
      expect(JSON.stringify(instance.state)).not.toContain("dispatchSig");
      return OUTPUT;
    });
    const execute = instance.getTools().delegate_coding_task!.execute!;
    await execute(INPUT, { toolCallId: "fresh", messages: [], context: undefined });
    expect(captured?.generation).toBe(1);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(instance.state.runs[0]?.status).toBe("completed");
  });

  it("never dispatches when private snapshot persistence fails", async () => {
    const { instance, storage } = host();
    approveDirect(instance, "fresh", INPUT);
    instance.state.runs[0]!.sandboxId = makeSandboxId(INPUT.repoUrl, INPUT.task, "fresh");
    storage.put = async () => { throw new Error("storage unavailable"); };
    const execute = instance.getTools().delegate_coding_task!.execute!;
    await expect(execute(INPUT, { toolCallId: "fresh", messages: [], context: undefined })).rejects.toThrow("storage unavailable");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("executes a valid oversized task without storing a recovery snapshot", async () => {
    const { instance, records } = host();
    const large = { ...INPUT, task: "x".repeat(125_000) };
    approveDirect(instance, "fresh", large);
    instance.state.runs[0]!.sandboxId = makeSandboxId(large.repoUrl, large.task, "fresh");
    mocks.execute.mockImplementation(async () => {
      expect(records.has(parentRecoveryKey("agent-tool:fresh"))).toBe(false);
      return OUTPUT;
    });
    const execute = instance.getTools().delegate_coding_task!.execute!;
    await execute(large, { toolCallId: "fresh", messages: [], context: undefined });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(instance.state.runs[0]?.status).toBe("completed");
  });

  it.each(["harness", "complete"])("settles the original %s child through shared finalization", async (phase) => {
    const { instance, run, inspect, records, snapshot } = await fixture();
    inspect.mockResolvedValueOnce({ phase, envelopeHash: snapshot.input.dispatchEnvelopeHash, expiresAt: snapshot.input.dispatchExpiresAt });
    await instance.onStart();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("completed"));
    expect(instance.runAgentTool).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      runId: run.runId, parentToolCallId: "recover", input: expect.any(String),
    });
    const attachedInput = vi.mocked(instance.runAgentTool).mock.calls[0]![1].input as string;
    expect(parseAgentToolInput([{ role: "user", text: attachedInput }])).toEqual(snapshot.input);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.subAgent).toHaveBeenCalledOnce();
    expect(instance.state.runs[0]?.generation).toBe(2);
    await vi.waitFor(() => expect(records.has(parentRecoveryKey(run.runId))).toBe(false));
  });

  it("reattaches from signed run evidence when the old approval pointer was pruned", async () => {
    const { instance } = await fixture();
    instance.setState({ ...instance.state, pendingApprovals: [] });
    await instance.onStart();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("completed"));
    expect(instance.runAgentTool).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses an explicitly changed approval pointer", async () => {
    const { instance } = await fixture();
    instance.state.pendingApprovals![0]!.status = "rejected";
    await instance.onStart();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("unknown"));
    expect(instance.runAgentTool).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(instance.cancelAgentTool).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.destroy).toHaveBeenCalled());
  });

  it.each(["outcome_unknown", "container_lost"] as const)("preserves structured %s instead of reporting an ordinary executor failure", async (errorCode) => {
    const { instance } = await fixture();
    vi.mocked(instance.runAgentTool).mockResolvedValueOnce({ status: "completed", summary: formatAgentResult({
      status: "error", errorCode, summary: "Execution outcome is uncertain.", exitCode: -1,
      stderrTail: "", changedFiles: [], files: [], diff: "",
    }) });
    await instance.onStart();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("unknown"));
    expect(instance.state.runs[0]?.errorCode).toBe(errorCode);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("releases the container when private snapshot deletion fails", async () => {
    const { instance, storage, held, records } = await fixture();
    records.set(parentRecoveryKey("agent-tool:old-terminal"), {});
    storage.delete = async () => { throw new Error("cleanup unavailable"); };
    await instance.onStart();
    await Promise.allSettled(held);
    expect(instance.state.runs[0]?.status).toBe("completed");
    expect(mocks.destroy).toHaveBeenCalled();
    expect(instance.state.runs[0]?.error).toBeUndefined();
  });

  it("cancels a surviving child before releasing an unrecoverable phase", async () => {
    const { instance, inspect, held } = await fixture();
    const effects: string[] = [];
    inspect.mockResolvedValueOnce(null as never);
    vi.mocked(instance.cancelAgentTool).mockImplementation(async () => { effects.push("cancel"); });
    mocks.destroy.mockImplementation(async () => { effects.push("destroy"); });
    await instance.onStart();
    await Promise.allSettled(held);
    expect(instance.state.runs[0]?.status).toBe("unknown");
    expect(effects.indexOf("cancel")).toBeLessThan(effects.indexOf("destroy"));
    expect(instance.runAgentTool).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not attach when cancellation lands while the child probe is pending", async () => {
    const { instance, inspect, snapshot, held } = await fixture();
    let resolve: (value: { phase: string; envelopeHash: string | undefined; expiresAt: number | undefined }) => void = () => undefined;
    inspect.mockImplementationOnce(() => new Promise((finish) => { resolve = finish; }));
    await instance.onStart();
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    await instance.cancelRun("agent-tool:recover");
    resolve({ phase: "harness", envelopeHash: snapshot.input.dispatchEnvelopeHash, expiresAt: snapshot.input.dispatchExpiresAt });
    await Promise.allSettled(held);
    expect(instance.state.runs[0]?.status).toBe("cancelled");
    expect(instance.cancelAgentTool).toHaveBeenCalledOnce();
    expect(instance.runAgentTool).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["missing-registry", "missing-snapshot", "wrong-generation", "settling", "probe-rejected", "expired"])("stops %s without starting a facet or CLI", async (failure) => {
    const { instance, run, records, inspect, snapshot } = await fixture();
    if (failure === "missing-registry") vi.mocked(instance.hasAgentToolRun).mockReturnValue(false);
    if (failure === "missing-snapshot") records.clear();
    if (failure === "wrong-generation") snapshot.generation++;
    if (failure === "settling") inspect.mockResolvedValueOnce(null as never);
    if (failure === "probe-rejected") inspect.mockRejectedValueOnce(new Error("Worker unavailable"));
    if (failure === "expired") snapshot.input.dispatchExpiresAt = Date.now() - 1;
    await instance.onStart();
    await vi.waitFor(() => expect(instance.state.runs[0]?.status).toBe("unknown"));
    expect(instance.runAgentTool).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    if (["missing-registry", "missing-snapshot", "wrong-generation", "expired"].includes(failure)) expect(instance.subAgent).not.toHaveBeenCalled();
    expect(run.runId).toBe("agent-tool:recover");
  });

  it("cancels the original SDK run and fences a late result", async () => {
    const { instance } = await fixture();
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(instance.runAgentTool).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    await instance.onStart();
    await vi.waitFor(() => expect(instance.runAgentTool).toHaveBeenCalledOnce());
    await instance.cancelRun("agent-tool:recover");
    await vi.waitFor(() => expect(instance.cancelAgentTool).toHaveBeenCalledOnce());
    finish({ status: "completed", summary: OUTPUT });
    expect(instance.state.runs[0]?.status).toBe("cancelled");
    expect(instance.state.runs[0]?.summary).toBeUndefined();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("uses the original dispatch deadline for cancellation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const { instance } = await fixture(Date.now() - RUN_DEADLINE_MS + 10_000);
      vi.mocked(instance.runAgentTool).mockImplementation(() => new Promise(() => undefined));
      await instance.onStart();
      await vi.waitFor(() => expect(instance.runAgentTool).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(instance.cancelAgentTool).toHaveBeenCalledOnce();
      expect(instance.state.runs[0]?.status).toBe("error");
      expect(instance.state.runs[0]?.errorCode).toBe("timeout_scope");
    } finally {
      vi.useRealTimers();
    }
  });
});
