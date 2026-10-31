import { beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingRunFields, runInputHash, createPendingApproval, type PendingApproval } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { preparedGoal } from "./fixtures/onboarding-goal.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { createSkill, reviewSkill, activateSkill } from "../src/skills-store.js";
import { CodingOrchestrator, delegateInputSchema, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { handleRuns } from "../src/runs-routes.js";
import type { createRun } from "../src/runs.js";
import { readDraftTaskReference, resolveOnboardingTaskBinding, revalidateOnboardingBinding } from "../src/onboarding-task-binding.js";
import { formatAgentResult, parseAgentToolInput } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({ target: null as unknown, execute: vi.fn(), forwarded: [] as Record<string, unknown>[] }));
vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } keepAliveWhile<T>(run: () => Promise<T>) { return run(); } async schedule() { return {}; } } }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async (request: Request) => {
  mocks.forwarded.push(await request.clone().json());
  return (mocks.target as CodingOrchestrator).onRequest(request);
} }) }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "owner@example.test",
}));

async function fixture() {
  const env = { ...productionEnvStubs(), AGENT_AUDIT: customAgentD1().database, CodingOrchestrator: {}, Sandbox: {} } as unknown as Env;
  const employee = await createCustomAgent(env, "self-hosted", "research", { name: "Research", instructions: "Produce an editable draft", harness: "opencode" });
  const goal = await preparedGoal(env, "owner@example.test", employee.id, employee.version);
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype), {
    name: "owner@example.test", env, state: { runs: [] },
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  }) as CodingOrchestrator;
  mocks.target = instance;
  const http = (extra: Record<string, unknown> = {}) => handleRuns(new Request("https://shiba.test/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://shiba.test" },
    body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: goal.task, customAgentId: employee.id, ...goal.reference, ...extra }),
  }), env);
  return { env, employee, goal, instance, http };
}
beforeEach(() => { mocks.execute.mockClear(); mocks.forwarded = []; });
setSandboxHandleResolver(() => ({ destroy: async () => undefined }));

describe("validated first-task admission", () => {
  it("fails forged, missing, wrong-owner, changed and unprepared references closed", async () => {
    const f = await fixture();
    expect(readDraftTaskReference({})).toBeUndefined();
    for (const raw of [{ draftTaskId: f.goal.reference.draftTaskId }, { draftTaskVersion: 1 }, { ...f.goal.reference, draftTaskId: "forged" }, { ...f.goal.reference, draftTaskVersion: 0 }]) {
      expect(() => readDraftTaskReference(raw)).toThrow("Invalid onboarding goal reference");
    }
    await expect(resolveOnboardingTaskBinding(f.env, "other@example.test", f.goal.task, f.goal.reference)).rejects.toThrow("changed");
    await expect(resolveOnboardingTaskBinding(f.env, "owner@example.test", "Unrelated task", f.goal.reference)).rejects.toThrow("exactly match");
    await expect(resolveOnboardingTaskBinding(f.env, "owner@example.test", f.goal.task, f.goal.reference, "different-employee")).rejects.toThrow("does not match");
    expect((await f.http({ task: "Unrelated task" }))?.status).toBe(409);
    expect((await f.http({ onboardingSourceSnapshot: { sources: [] } }))?.status).toBe(400);
    const current = await f.goal.update();
    await f.goal.update({ action: "save-draft", expectedRevision: current.revision, draftTask: { audience: "Changed audience" } });
    expect((await f.http())?.status).toBe(409);
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("validates HTTP canonical text before reviewed skills, freezes sources and requires approval", async () => {
    const f = await fixture();
    const skill = await createSkill(f.env, "self-hosted", "owner@example.test", { name: "Evidence", instructions: "Include a verification checklist" });
    await reviewSkill(f.env, "self-hosted", "owner@example.test", skill.id, 1, skill.content.instructions);
    await activateSkill(f.env, "self-hosted", "owner@example.test", skill.id, 1, skill.content.instructions);
    const response = await f.http({ skillPins: [{ skillId: skill.id, version: 1 }] });
    expect(response?.status).toBe(200);
    expect(mocks.forwarded[0]?.task).toBe(f.goal.task);
    const pointer = f.instance.state.pendingApprovals?.[0];
    expect(pointer).toMatchObject({ ...f.goal.reference, status: "pending", onboardingSourceSnapshot: { sources: [f.goal.source] } });
    expect(pointer?.task).toContain("Include a verification checklist");
    expect(pointer?.task).toContain(f.goal.task);
    expect(f.instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
    if (!pointer) throw new Error("Missing approval");
    const approved = { ...pointer, status: "approved", decidedBy: "owner@example.test", decidedAt: 123 } as PendingApproval;
    const run = (f.instance as unknown as { mintApprovedRun(record: PendingApproval): ReturnType<typeof createRun> }).mintApprovedRun(approved);
    expect(run).toMatchObject(f.goal.reference);
    const originalHash = runInputHash(run);
    expect(originalHash).toBe(run.approval?.inputHash);
    expect(f.instance.state.tasks?.[0]?.attempts[0]?.frozen.inputHash).toBe(originalHash);
    expect(runInputHash({ ...run, draftTaskVersion: (run.draftTaskVersion ?? 0) + 1 })).not.toBe(originalHash);
    f.goal.source.version = 2;
    f.goal.source.sha256 = "b".repeat(64);
    f.goal.source.content = "Edited after approval";
    expect(run.onboardingSourceSnapshot?.sources[0]?.content).toContain("Selected facts");
    await expect(revalidateOnboardingBinding(f.env, "owner@example.test", run)).rejects.toThrow("changed");
  });

  it("accepts only latest-user composer goal hints and omits goal authority from model schema", async () => {
    const f = await fixture();
    expect(delegateInputSchema.shape).not.toHaveProperty("draftTaskId");
    Object.assign(f.instance, { messages: [{ role: "user", metadata: { shibaTask: { task: f.goal.task, repoUrl: "https://github.com/o/r", customAgentId: f.employee.id, ...f.goal.reference } } },
      { role: "assistant", metadata: { shibaTask: { draftTaskId: "forged", draftTaskVersion: 999 } } }] });
    const gate = f.instance.getTools().delegate_coding_task as unknown as { needsApproval(input: unknown, options: { toolCallId: string }): Promise<boolean> };
    await expect(gate.needsApproval({ repoUrl: "https://github.com/o/r", task: "Model paraphrase", baseBranch: "main", publishPullRequest: false }, { toolCallId: "goal-composer" })).resolves.toBe(true);
    expect(f.instance.state.pendingApprovals?.[0]).toMatchObject(f.goal.reference);
    Object.assign(f.instance, { messages: [{ role: "user", metadata: { shibaTask: { task: f.goal.task, draftTaskId: f.goal.reference.draftTaskId } } }] });
    await expect(gate.needsApproval({ repoUrl: "https://github.com/o/r", task: f.goal.task }, { toolCallId: "malformed-goal" })).rejects.toThrow("Invalid onboarding goal reference");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized escaped source snapshot before approval or execution", async () => {
    const f = await fixture();
    f.goal.source.content = "<".repeat(1600);
    const response = await f.http();
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining("8 KiB") });
    expect(f.instance.state.pendingApprovals ?? []).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("hashes the complete immutable context without changing ordinary approval hashes", async () => {
    const input = { repoUrl: "https://github.com/o/r", task: "Brief", baseBranch: "main", publishPullRequest: false };
    const f = await fixture();
    const binding = await resolveOnboardingTaskBinding(f.env, "owner@example.test", f.goal.task, f.goal.reference);
    if (!binding) throw new Error("Missing binding");
    const copy = onboardingRunFields(binding);
    const [approval] = createPendingApproval([], { ...input, ...copy, threadKey: "owner@example.test", approvalId: "approval", createdAt: 1 });
    expect(approval).toMatchObject(f.goal.reference);
    expect(runInputHash(input)).toBe(runInputHash({ ...input, ...onboardingRunFields({}) }));
    const hash = runInputHash({ ...input, ...copy });
    const snapshot = structuredClone(copy.onboardingSourceSnapshot);
    if (!snapshot?.sources[0]) throw new Error("Missing source");
    snapshot.sources[0].content = "Different approved bytes";
    expect(runInputHash({ ...input, ...copy, onboardingSourceSnapshot: snapshot })).not.toBe(hash);
  });

  it("dispatches the frozen goal envelope, but refuses stale goal execution and retry without a sandbox", async () => {
    const f = await fixture();
    await f.http();
    const pointer = f.instance.state.pendingApprovals?.[0];
    if (!pointer) throw new Error("Missing pointer");
    const approved = { ...pointer, status: "approved", decidedBy: "owner@example.test", decidedAt: 123 } as PendingApproval;
    const run = (f.instance as unknown as { mintApprovedRun(record: PendingApproval): ReturnType<typeof createRun> }).mintApprovedRun(approved);
    f.instance.setState({ ...f.instance.state, pendingApprovals: [approved], runs: [run] });
    mocks.execute.mockResolvedValue(formatAgentResult({ status: "completed", summary: "Draft ready", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [] }));
    const delegate = f.instance.getTools().delegate_coding_task as unknown as { execute(input: unknown, options: { toolCallId: string }): Promise<unknown> };
    await delegate.execute({}, { toolCallId: pointer.approvalId });
    const envelope = parseAgentToolInput([{ role: "user", text: String(mocks.execute.mock.calls[0]?.[0]) }]);
    expect(envelope).toMatchObject({ ...f.goal.reference, onboardingSourceSnapshot: { sources: [f.goal.source] } });

    const stale = await fixture();
    await stale.http();
    const stalePointer = stale.instance.state.pendingApprovals?.[0];
    if (!stalePointer) throw new Error("Missing stale pointer");
    const staleApproved = { ...stalePointer, status: "approved", decidedBy: "owner@example.test", decidedAt: 123 } as PendingApproval;
    const staleRun = (stale.instance as unknown as { mintApprovedRun(record: PendingApproval): ReturnType<typeof createRun> }).mintApprovedRun(staleApproved);
    stale.instance.setState({ ...stale.instance.state, pendingApprovals: [staleApproved], runs: [staleRun] });
    const current = await stale.goal.update();
    await stale.goal.update({ action: "save-draft", expectedRevision: current.revision, draftTask: { goal: "Edited outcome" } });
    mocks.execute.mockClear();
    const staleDelegate = stale.instance.getTools().delegate_coding_task as unknown as typeof delegate;
    await expect(staleDelegate.execute({}, { toolCallId: stalePointer.approvalId })).rejects.toThrow("changed");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(stale.instance.state.runs[0]?.status).toBe("error");
    const retry = await stale.instance.onRequest(new Request(`https://internal/api/tasks/task_${stalePointer.approvalId}/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commandId: "retry-old-goal" }),
    }));
    expect(retry.status).toBe(409);
    expect(stale.instance.state.pendingApprovals).toHaveLength(1);
    expect(stale.instance.state.pendingApprovals?.[0]?.onboardingSourceSnapshot).toEqual(stalePointer.onboardingSourceSnapshot);
  });

  it.each(["goal", "source"])("rechecks %s changes during the final awaited route check", async (change) => {
    const f = await fixture();
    await f.http();
    const pointer = f.instance.state.pendingApprovals?.[0];
    if (!pointer) throw new Error("Missing pointer");
    const approved = { ...pointer, status: "approved", decidedBy: "owner@example.test", decidedAt: 123 } as PendingApproval;
    const run = (f.instance as unknown as { mintApprovedRun(record: PendingApproval): ReturnType<typeof createRun> }).mintApprovedRun(approved);
    f.instance.setState({ ...f.instance.state, pendingApprovals: [approved], runs: [run] });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void;
    const lateCheck = new Promise<void>((resolve) => { entered = resolve; });
    f.env.ModelConfig = { idFromName: () => ({}), get: () => ({ fetch: async () => {
      entered();
      await paused;
      return Response.json({ connections: [], policy: {} });
    } }) } as unknown as Env["ModelConfig"];
    const delegate = f.instance.getTools().delegate_coding_task as unknown as { execute(input: unknown, options: { toolCallId: string }): Promise<unknown> };
    const executing = delegate.execute({}, { toolCallId: pointer.approvalId });
    await lateCheck;
    if (change === "goal") {
      const current = await f.goal.update();
      await f.goal.update({ action: "save-draft", expectedRevision: current.revision, draftTask: { audience: "Changed during route validation" } });
    } else { f.goal.source.version = 2; f.goal.source.sha256 = "b".repeat(64); }
    resume();
    await expect(executing).rejects.toThrow("changed");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(f.instance.state.runs[0]?.status).toBe("error");
    expect(f.instance.state.runs[0]?.onboardingSourceSnapshot?.sources[0]?.version).toBe(1);
  });

  it.each(["chat", "app-tools"])("dispatches an approved frozen goal after the latest turn changes to %s", async (mode) => {
    const f = await fixture();
    await f.http();
    const pointer = f.instance.state.pendingApprovals?.[0];
    if (!pointer) throw new Error("Missing pointer");
    Object.assign(f.instance, { messages: [{ role: "user", parts: [{ type: "text", text: "Discuss something else" }], metadata:
      mode === "chat" ? { shibaMode: "chat" } : { shibaMode: "work", shibaWorkTarget: "app-tools" },
    }] });
    mocks.execute.mockResolvedValue(formatAgentResult({ status: "completed", summary: "Frozen draft ready", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [] }));
    const response = await f.instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: pointer.approvalId, threadKey: pointer.threadKey, approved: true, decidedBy: "owner@example.test" }),
    }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(f.instance.state.runs[0]?.status).toBe("completed"));
    const envelope = parseAgentToolInput([{ role: "user", text: String(mocks.execute.mock.calls[0]?.[0]) }]);
    expect(envelope).toMatchObject({ ...f.goal.reference, task: pointer.task, onboardingSourceSnapshot: pointer.onboardingSourceSnapshot });
  });
});
