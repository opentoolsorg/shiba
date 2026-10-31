import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { createRun } from "../src/runs.js";
import { AGENT_PRINCIPAL_HEADER, runInputHash } from "@shiba/shared";
import { frozenTaskInputFromApproval } from "../src/task-attempts.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()) }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return mocks.keepAliveWhile(fn); }
  schedule() { return {}; }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

function host(state: OrchestratorState = { runs: [] }, name = "task-owner") {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name,
    env: { ...productionEnvStubs(), Sandbox: {} },
    state,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
}

function post(url: string, body: unknown) {
  return new Request(`https://internal${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => { vi.resetAllMocks(); });

describe("orchestrator durable task-attempt routes", () => {
  it("freezes room and employee-policy authority into the exact approved input hash", () => {
    const approval = {
      threadKey: "room-owner",
      approvalId: "room-approval",
      repoUrl: "",
      task: "Write the approved report",
      baseBranch: "main",
      publishPullRequest: false,
      collaborationHandoffId: "room-handoff-123",
      employeeToolPolicyVersion: 9,
      status: "pending" as const,
      createdAt: 123,
    };
    const frozen = frozenTaskInputFromApproval(approval);
    expect(frozen.body).toMatchObject({
      collaborationHandoffId: approval.collaborationHandoffId,
      employeeToolPolicyVersion: approval.employeeToolPolicyVersion,
    });
    expect(frozen.inputHash).toBe(runInputHash({
      repoUrl: "",
      task: approval.task,
      baseBranch: "main",
      publishPullRequest: false,
      collaborationHandoffId: approval.collaborationHandoffId,
      employeeToolPolicyVersion: approval.employeeToolPolicyVersion,
    }));
  });

  it("queues, retries the exact frozen approval, reloads, and cancels without executing a provider", async () => {
    const original = host();
    const queued = await original.onRequest(post("/api/runs", {
      repoUrl: "https://github.com/o/r",
      task: "Fix the parser",
      baseBranch: "main",
      publishPullRequest: false,
    }));
    expect(queued.status).toBe(200);
    const { approvalId } = await queued.json() as { approvalId: string };

    const firstList = await (await original.onRequest(new Request("https://internal/api/tasks"))).json() as {
      tasks: { taskId: string; attempts: { attempt: number; approvalId?: string; status: string }[] }[];
    };
    expect(firstList.tasks).toHaveLength(1);
    const initialTask = firstList.tasks[0];
    if (!initialTask) throw new Error("Expected queued task history entry.");
    const taskId = initialTask.taskId;
    expect(initialTask.attempts).toMatchObject([{ attempt: 1, approvalId, status: "pending_approval" }]);
    // HTTP projection never discloses the persisted frozen request body.
    expect(JSON.stringify(firstList)).not.toContain("frozen");

    const cancelledFirst = await original.onRequest(post(`/api/tasks/${taskId}/cancel`, { attempt: 1 }));
    expect(cancelledFirst.status).toBe(200);
    expect(mocks.execute).not.toHaveBeenCalled();
    const retry = await original.onRequest(post(`/api/tasks/${taskId}/retry`, { commandId: "retry-task-0001" }));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { approvalId: string; task: { attempts: { attempt: number; approvalId: string; status: string }[] } };
    expect(retryBody.approvalId).not.toBe(approvalId);
    expect(retryBody.task.attempts).toMatchObject([
      { attempt: 1, approvalId, status: "cancelled" },
      { attempt: 2, approvalId: retryBody.approvalId, status: "pending_approval" },
    ]);
    const firstStored = original.state.tasks?.[0]?.attempts[0];
    const secondStored = original.state.tasks?.[0]?.attempts[1];
    expect(secondStored?.frozen.inputHash).toBe(firstStored?.frozen.inputHash);
    expect(secondStored?.frozen.threadKey).toBe(firstStored?.frozen.threadKey);

    // Resolve the new approval only in the in-memory orchestrator; dispatch is
    // replaced with a deterministic spy, so no provider or sandbox is started.
    const dispatch = vi.fn();
    Object.assign(original, { dispatchApprovedRun: dispatch });
    const approved = await original.onRequest(post("/api/approvals", {
      threadKey: secondStored?.frozen.threadKey,
      approvalId: retryBody.approvalId,
      approved: true,
      decidedBy: "test-human",
    }));
    expect(approved.status).toBe(200);
    expect(original.state.runs[0]?.approval?.inputHash).toBe(secondStored?.frozen.inputHash);
    expect(dispatch).toHaveBeenCalledOnce();

    // Durable Object state survives hibernation/reconstruction as JSON.
    const restarted = host(JSON.parse(JSON.stringify(original.state)) as OrchestratorState);
    Object.assign(restarted, { releaseSandboxForRun: vi.fn(async () => undefined) });
    const reloaded = await (await restarted.onRequest(new Request("https://internal/api/tasks"))).json() as typeof firstList;
    expect(reloaded.tasks[0]?.attempts).toHaveLength(2);
    const cancelledSecond = await restarted.onRequest(post(`/api/tasks/${taskId}/cancel`, { attempt: 2 }));
    expect(cancelledSecond.status).toBe(200);
    const final = await (await restarted.onRequest(new Request("https://internal/api/tasks"))).json() as typeof firstList;
    expect(final.tasks[0]?.attempts.map((attempt) => attempt.status)).toEqual(["cancelled", "cancelled"]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("deduplicates retry commands and scopes task access to the owning orchestrator", async () => {
    const owner = host();
    const queued = await owner.onRequest(post("/api/runs", { repoUrl: "https://github.com/o/r", task: "Fix" }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const taskId = `task_${approvalId}`;
    await owner.onRequest(post(`/api/tasks/${taskId}/cancel`, { attempt: 1 }));
    const once = await owner.onRequest(post(`/api/tasks/${taskId}/retry`, { commandId: "retry-task-0002" }));
    const onceBody = await once.json() as { approvalId: string };
    const replay = await owner.onRequest(post(`/api/tasks/${taskId}/retry`, { commandId: "retry-task-0002" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ approvalId: onceBody.approvalId, deduped: true });

    const otherOwner = host({ runs: [] }, "another-owner");
    const hidden = await otherOwner.onRequest(new Request(`https://internal/api/tasks/${taskId}/retry`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: "retry-task-0003" }),
    }));
    expect(hidden.status).toBe(404);
  });

  it("requires a new room handoff instead of minting a retry bound to an old approval id", async () => {
    const owner = host();
    const queued = await owner.onRequest(post("/api/runs", {
      repoUrl: "https://github.com/o/r", task: "Room task", publishPullRequest: false,
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const taskId = `task_${approvalId}`;
    await owner.onRequest(post(`/api/tasks/${taskId}/cancel`, { attempt: 1 }));
    const record = owner.state.tasks?.[0];
    const attempt = record?.attempts[0];
    if (!attempt) throw new Error("Expected the frozen task attempt.");
    (attempt.frozen.body as Record<string, unknown>).collaborationHandoffId = "room-old-handoff";
    const existingApprovalCount = owner.state.pendingApprovals?.length ?? 0;

    const retry = await owner.onRequest(post(`/api/tasks/${taskId}/retry`, { commandId: "retry-room-task-0001" }));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: expect.stringContaining("requested again in the room") });
    expect(owner.state.pendingApprovals).toHaveLength(existingApprovalCount);
  });

  it("preserves queued and updated task attempts when run cleanup is held during cancellation", async () => {
    const instance = host();
    const queuedA = await instance.onRequest(post("/api/runs", {
      repoUrl: "https://github.com/o/r",
      task: "Cancel slowly",
      publishPullRequest: false,
    }));
    const { approvalId: approvalA } = await queuedA.json() as { approvalId: string };
    const taskAId = `task_${approvalA}`;
    Object.assign(instance, { dispatchApprovedRun: vi.fn() });
    const approvedA = await instance.onRequest(post("/api/approvals", {
      threadKey: "default",
      approvalId: approvalA,
      approved: true,
      decidedBy: "test-human",
    }));
    expect(approvedA.status).toBe(200);
    const runAId = instance.state.runs[0]?.runId;
    expect(runAId).toBeDefined();

    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    Object.assign(instance, {
      releaseSandboxForRun: vi.fn(async () => {
        cleanupStarted();
        await cleanup;
      }),
    });

    const cancelA = instance.onRequest(post(`/api/tasks/${taskAId}/cancel`, { attempt: 1 }));
    await cleanupStartedPromise;

    // The run store was already fenced as cancelled before provider cleanup
    // yields. A concurrent history read persists that newer attempt state.
    const duringCleanup = await (await instance.onRequest(new Request("https://internal/api/tasks"))).json() as {
      tasks: { taskId: string; attempts: { status: string; runId?: string; updatedAt: number }[] }[];
    };
    const updatedA = duringCleanup.tasks.find((task) => task.taskId === taskAId)?.attempts[0];
    expect(updatedA).toMatchObject({ status: "cancelled", runId: runAId });
    const updatedAtDuringCleanup = updatedA?.updatedAt;
    expect(updatedAtDuringCleanup).toBeTypeOf("number");

    // Queue B and resolve its approval while A's cleanup remains held. This
    // writes a second durable task attempt after cancelTask captured its list.
    const queuedB = await instance.onRequest(post("/api/runs", {
      repoUrl: "https://github.com/o/r",
      task: "Keep this queued task",
      publishPullRequest: false,
    }));
    const { approvalId: approvalB } = await queuedB.json() as { approvalId: string };
    const taskBId = `task_${approvalB}`;
    const cancelB = await instance.onRequest(post(`/api/tasks/${taskBId}/cancel`, { attempt: 1 }));
    expect(cancelB.status).toBe(200);

    finishCleanup();
    const responseA = await cancelA;
    expect(responseA.status).toBe(200);
    const final = await (await instance.onRequest(new Request("https://internal/api/tasks"))).json() as typeof duringCleanup;
    expect(final.tasks.map((task) => task.taskId)).toEqual(expect.arrayContaining([taskAId, taskBId]));
    expect(final.tasks.find((task) => task.taskId === taskAId)?.attempts[0]).toMatchObject({
      status: "cancelled",
      runId: runAId,
      updatedAt: updatedAtDuringCleanup,
    });
    expect(final.tasks.find((task) => task.taskId === taskBId)?.attempts[0]?.status).toBe("cancelled");
  });

  it("refuses retries when the latest run outcome is uncertain", async () => {
    const instance = host();
    const queued = await instance.onRequest(post("/api/runs", { repoUrl: "https://github.com/o/r", task: "Inspect" }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const taskId = `task_${approvalId}`;
    await instance.onRequest(post(`/api/tasks/${taskId}/cancel`, { attempt: 1 }));
    // A task is not replayed after uncertain side effects; confirm the API's
    // guard against manually persisted unknown executor outcomes as well.
    const task = instance.state.tasks?.[0];
    if (!task) throw new Error("Expected task history record.");
    instance.setState({ ...instance.state, tasks: [{
      ...task,
      attempts: task.attempts.map((attempt) => ({ ...attempt, status: "unknown" as const })),
    }] });
    const retry = await instance.onRequest(post(`/api/tasks/${taskId}/retry`, { commandId: "retry-task-0004" }));
    expect(retry.status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("backfills legacy retained runs into history without changing their run IDs", async () => {
    const run = createRun({
      runId: "legacy-run-id",
      sandboxId: "legacy-sandbox",
      repoUrl: "https://github.com/o/r",
      task: "Existing run",
      baseBranch: "main",
      publishPullRequest: false,
    });
    const instance = host({ runs: [run] });
    const response = await instance.onRequest(new Request("https://internal/api/tasks"));
    const body = await response.json() as { tasks: { taskId: string; attempts: { runId?: string; retryable?: boolean }[] }[] };
    expect(body.tasks).toMatchObject([{ taskId: "legacy:legacy-run-id", attempts: [{ runId: "legacy-run-id", retryable: false }] }]);
    expect(instance.state.tasks).toHaveLength(1);
    const existingRuns = await instance.onRequest(new Request("https://internal/api/runs"));
    expect(await existingRuns.json()).toMatchObject({ runs: [{ runId: "legacy-run-id" }] });
  });

  it("scopes internal agent principals to the tasks they queued", async () => {
    const instance = host();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", [AGENT_PRINCIPAL_HEADER]: "agent-one" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "Agent task", queuedBy: "forged" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    const taskId = `task_${approvalId}`;
    const own = await instance.onRequest(new Request("https://internal/api/tasks", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "agent-one" },
    }));
    expect(await own.json()).toMatchObject({ tasks: [{ taskId }] });
    const agentCancel = await instance.onRequest(new Request(`https://internal/api/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", [AGENT_PRINCIPAL_HEADER]: "agent-one" },
      body: JSON.stringify({ attempt: 1 }),
    }));
    expect(agentCancel.status).toBe(403);
    const foreign = await instance.onRequest(new Request("https://internal/api/tasks", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "agent-two" },
    }));
    expect(await foreign.json()).toEqual({ tasks: [] });
    const cancel = await instance.onRequest(new Request(`https://internal/api/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", [AGENT_PRINCIPAL_HEADER]: "agent-two" },
      body: JSON.stringify({ attempt: 1 }),
    }));
    expect(cancel.status).toBe(404);
  });
});
