import { describe, expect, it, vi } from "vitest";
import type { ChatResponseResult } from "@cloudflare/think";
import { continuationDecision, type PlanStep } from "../src/agents/plan-continuation.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { onboardingTaskText } from "@shiba/shared";
import { resolvePreparedOnboardingDraft } from "../src/onboarding-progress.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({}) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/onboarding-progress.js", () => ({ resolvePreparedOnboardingDraft: vi.fn() }));

const openPlan: PlanStep[] = [{ step: "Finish tests", status: "pending" }];
const defaults = { text: "Working.", plan: openPlan, count: 0, pendingApproval: false, limitReached: false, completed: true };

describe("continuation policy", () => {
  it("continues open plan steps", () => {
    expect(continuationDecision(defaults)).toEqual({ continue: true, reason: "open_plan_steps" });
  });
  it.each(["Shall I continue?", "Want me to keep going?", "Tests passed.\nShould I continue with the remaining steps?"])("continues only the same work: %s", (text) => {
    expect(continuationDecision({ ...defaults, text, plan: [] })).toEqual({ continue: true, reason: "continue_question" });
  });
  it.each(["Please approve this.", "Should I proceed with the remaining steps?", "Can I go ahead?", "Please confirm."])("stops for approval language: %s", (text) => {
    expect(continuationDecision({ ...defaults, text }).reason).toBe("approval_language");
  });
  it.each(["Should I send the email?", "Shall I deploy?", "Can I delete this?", "Should we send it?", "Would you like to deploy?", "Should I publish?\nShall I continue?"])("stops when a new action is named: %s", (text) => {
    expect(continuationDecision({ ...defaults, text })).toEqual({ continue: false, reason: "new_action_or_question" });
  });
  it("stops for pending approval", () => {
    expect(continuationDecision({ ...defaults, pendingApproval: true }).reason).toBe("pending_approval");
  });
  it.each([
    { shibaDraftTaskId: "prepared-goal" },
    { shibaDraftTaskVersion: 1 },
    { shibaTask: { draftTaskId: "prepared-goal", task: "Prepared brief" } },
    { shibaTask: { draftTaskVersion: 1 } },
  ])("stops for prepared goal metadata: %j", (messageMetadata) => {
    expect(continuationDecision({ ...defaults, messageMetadata })).toEqual({ continue: false, reason: "prepared_goal" });
  });
  it("stops at a budget limit", () => {
    expect(continuationDecision({ ...defaults, limitReached: true }).reason).toBe("usage_limit");
    expect(continuationDecision({ ...defaults, text: "Usage limit reached." }).reason).toBe("usage_limit");
  });
  it("stops at three continuations", () => {
    expect(continuationDecision({ ...defaults, count: 3 }).reason).toBe("continuation_cap");
  });
  it("leaves empty and finished plans alone", () => {
    expect(continuationDecision({ ...defaults, text: "", plan: [] }).continue).toBe(false);
    expect(continuationDecision({ ...defaults, plan: [{ step: "Tests", status: "done" }] }).continue).toBe(false);
    expect(continuationDecision({ ...defaults, plan: [], text: `${"x".repeat(501)}\nShall I continue?` }).continue).toBe(false);
  });
  it("does not continue an errored or interrupted turn", () => {
    expect(continuationDecision({ ...defaults, completed: false }).reason).toBe("turn_not_completed");
  });
});

function host() {
  const held: Promise<unknown>[] = [];
  const runTurn = vi.fn(async () => ({}));
  const instance: CodingOrchestrator = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name: "session:private", env: productionEnvStubs(),
    state: { runs: [] } as OrchestratorState,
    messages: [{ id: "request-1", role: "user", metadata: { shibaWorkTarget: "app-tools" }, parts: [{ type: "text", text: "Do the work" }] }],
    ctx: { waitUntil(promise: Promise<unknown>) { held.push(promise); } },
    runTurn,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return { instance, runTurn, held };
}

const response = (id = "answer-1"): ChatResponseResult => ({ requestId: "turn-1", continuation: false, status: "completed",
  message: { id, role: "assistant", parts: [{ type: "text", text: "Shall I continue?" }] } });

describe("orchestrator completion hook", () => {
  it("does not replace a prepared app-tools brief with continuation text", async () => {
    const { instance, runTurn } = host();
    const draftTask = { goal: "Write a sourced draft", audience: "Owner", acceptance: "Editable draft", employeeId: "writer", sourceIds: [] };
    const reference = { draftTaskId: "draft_11111111-1111-4111-8111-111111111111", draftTaskVersion: 1 };
    vi.mocked(resolvePreparedOnboardingDraft).mockResolvedValue({ draftTask, draftTaskId: reference.draftTaskId, version: 1 } as never);
    Object.assign(instance, { messages: [{ id: "request-1", role: "user", parts: [{ type: "text", text: onboardingTaskText(draftTask) }],
      metadata: { shibaWorkTarget: "app-tools", shibaDraftTaskId: reference.draftTaskId, shibaDraftTaskVersion: 1 } }] });
    const binding = instance as unknown as { employeeOnboardingBinding(employeeId: string): Promise<unknown> };
    await expect(binding.employeeOnboardingBinding("writer")).resolves.toMatchObject(reference);
    instance.onChatResponse(response());
    expect(runTurn).not.toHaveBeenCalled();
    expect(instance.state.events?.at(-1)?.payload).toMatchObject({ summary: "Plan continuation stopped: prepared_goal" });
    await expect(binding.employeeOnboardingBinding("writer")).resolves.toMatchObject(reference);
  });
  it("durably queues a continuation, logs the reason, preserves scope, and deduplicates hook replay", async () => {
    const { instance, runTurn, held } = host();
    instance.onChatResponse(response());
    instance.onChatResponse(response());
    await Promise.all(held);
    expect(runTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "submit", submissionId: "plan-continuation:request-1:1",
      input: expect.objectContaining({ metadata: { shibaWorkTarget: "app-tools" } }),
      metadata: expect.objectContaining({ requestId: "request-1", reason: "continue_question", count: 1 }),
    }));
    expect(instance.state.events?.at(-1)).toMatchObject({ runId: "request-1", payload: { summary: "Plan continuation queued: continue_question" } });
    expect(instance.state.planContinuation?.count).toBe(1);
  });
  it("retains the cap across continued messages and resets for a new real request", async () => {
    const { instance, runTurn, held } = host();
    for (let index = 1; index <= 4; index++) {
      instance.onChatResponse(response(`answer-${index}`));
      const lastId = instance.state.planContinuation?.messageIds.at(-1);
      if (!lastId) throw new Error("Missing continuation message");
      Object.assign(instance, { messages: [{ id: lastId, role: "user", parts: [{ type: "text", text: "Continue" }] }] });
    }
    await Promise.all(held);
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(instance.state.events?.at(-1)?.payload).toMatchObject({ summary: "Plan continuation stopped: continuation_cap" });
    Object.assign(instance, { messages: [{ id: "new-request", role: "user", parts: [{ type: "text", text: "New work" }] }] });
    instance.onChatResponse(response("new-answer"));
    expect(instance.state.planContinuation?.count).toBe(1);
    expect(instance.state.planContinuation?.requestId).toBe("new-request");
  });
  it("queues open plans without a question and leaves unrelated responses unchanged", () => {
    const { instance, runTurn } = host();
    const result = response();
    result.message.parts = [{ type: "text", text: "First step finished." }];
    instance.onChatResponse(result);
    expect(runTurn).not.toHaveBeenCalled();
    instance.state.planContinuation = { requestId: "request-1", messageIds: [], count: 0, plan: openPlan };
    instance.onChatResponse(result);
    expect(runTurn).toHaveBeenCalledOnce();
  });
  it("does not enqueue when the run has a pending approval", () => {
    const { instance, runTurn } = host();
    instance.state.pendingApprovals = [{ threadKey: instance.name, approvalId: "approval", repoUrl: "https://github.com/o/r", task: "Work",
      baseBranch: "main", publishPullRequest: false, status: "pending", createdAt: Date.now() }];
    instance.onChatResponse(response());
    expect(runTurn).not.toHaveBeenCalled();
    expect(instance.state.events?.at(-1)?.payload).toMatchObject({ summary: "Plan continuation stopped: pending_approval" });
  });
  it("does not enqueue when the configured budget is exhausted", () => {
    const { instance, runTurn } = host();
    Object.assign(instance, { env: { ...productionEnvStubs(), SHIBA_DAILY_CONTAINER_BUDGET_USD: "1" } });
    instance.state.runs = [{ runId: "run-1", updatedAt: Date.now(), usage: { costUsd: 1 } } as OrchestratorState["runs"][number]];
    instance.onChatResponse(response());
    expect(runTurn).not.toHaveBeenCalled();
    expect(instance.state.events?.at(-1)?.payload).toMatchObject({ summary: "Plan continuation stopped: usage_limit" });
  });
  it("persists normal and empty plans and reports a missing request", async () => {
    const { instance } = host();
    const tools = (instance as unknown as { planTool(): { update_plan: { execute(input: { steps: PlanStep[] }): Promise<unknown> } } }).planTool();
    expect(await tools.update_plan.execute({ steps: openPlan })).toEqual({ steps: openPlan });
    expect(instance.state.planContinuation?.plan).toEqual(openPlan);
    expect(await tools.update_plan.execute({ steps: [] })).toEqual({ steps: [] });
    expect(instance.state.planContinuation?.plan).toEqual([]);
    Object.assign(instance, { messages: [] });
    expect(await tools.update_plan.execute({ steps: openPlan })).toEqual({ error: "No current request" });
  });
  it("records a failed enqueue without leaking the failure into the response hook", async () => {
    const { instance, runTurn, held } = host();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      runTurn.mockRejectedValueOnce(new Error("Queue unavailable"));
      instance.onChatResponse(response());
      await Promise.all(held);
      expect(instance.state.events?.at(-1)?.payload).toMatchObject({ summary: "Plan continuation stopped: queue_failed" });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
